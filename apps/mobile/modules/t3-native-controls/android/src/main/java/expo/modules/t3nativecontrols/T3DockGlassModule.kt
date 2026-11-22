package expo.modules.t3nativecontrols

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import androidx.annotation.RequiresApi
import com.facebook.react.uimanager.util.ReactFindViewUtil
import com.facebook.react.views.scroll.ReactScrollViewHelper
import com.facebook.react.views.scroll.ScrollEventType
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference
import kotlin.math.ceil

class T3DockGlassModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3DockGlass")

    View(T3DockSampleView::class) {
      Prop("targetNativeId") { view: T3DockSampleView, id: String ->
        view.setSampleTarget(id)
      }
      Prop("fallbackColor") { view: T3DockSampleView, color: Int ->
        view.setFallbackColor(color)
      }
      Prop("contentRevision") { view: T3DockSampleView, _: String -> view.requestSample() }
    }
  }
}

/** 从同窗口的普通 RN 内容视图取样，导航和触摸仍由原层级处理。 */
class T3DockSampleView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var targetNativeId: String? = null
  private var targetRef: WeakReference<View>? = null
  private var fallbackColor = Color.TRANSPARENT
  private var renderer: DockSampleRenderer? = null
  private var failed = false
  private var needsRecording = true
  private var treeObserver: ViewTreeObserver? = null
  private val sceneListener = ViewTreeObserver.OnPreDrawListener {
    updateSampleBeforeDraw()
    true
  }
  private val scrollListener = object : ReactScrollViewHelper.ScrollListener {
    override fun onScroll(
      scrollView: ViewGroup?,
      scrollEventType: ScrollEventType?,
      xVelocity: Float,
      yVelocity: Float
    ) {
      if (scrollEventType == ScrollEventType.SCROLL) onSourceScrollChange(scrollView)
    }

    override fun onLayout(scrollView: ViewGroup?) {
      onSourceScrollChange(scrollView)
    }
  }

  init {
    setWillNotDraw(false)
  }

  fun setSampleTarget(id: String) {
    if (targetNativeId == id) return
    targetNativeId = id
    targetRef = null
    needsRecording = true
    invalidate()
  }

  fun setFallbackColor(color: Int) {
    if (fallbackColor == color) return
    fallbackColor = color
    needsRecording = true
    invalidate()
  }

  fun requestSample() {
    if (needsRecording || failed) return
    needsRecording = true
    postInvalidateOnAnimation()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (Build.VERSION.SDK_INT < 33) return
    treeObserver = viewTreeObserver.also { it.addOnPreDrawListener(sceneListener) }
    ReactScrollViewHelper.addScrollListener(scrollListener)
  }

  override fun onDetachedFromWindow() {
    if (Build.VERSION.SDK_INT >= 33) {
      ReactScrollViewHelper.removeScrollListener(scrollListener)
      renderer?.release()
    }
    treeObserver?.takeIf { it.isAlive }?.removeOnPreDrawListener(sceneListener)
    treeObserver = null
    targetRef = null
    renderer = null
    needsRecording = true
    super.onDetachedFromWindow()
  }

  private fun onSourceScrollChange(scrollView: View?) {
    if (needsRecording || failed) return
    val target = targetRef?.get() ?: return
    // RN 的附加监听保留原有滚动处理，仅采样当前窗格及其子视图。
    if (isInViewSubtree(scrollView, target)) requestSample()
  }

  private fun sampleTarget(): View? {
    targetRef?.get()?.takeIf(::canSample)?.let { return it }
    targetRef = null
    val id = targetNativeId ?: return null
    val target = ReactFindViewUtil.findView(rootView, id) ?: return null
    if (!canSample(target)) return null
    // 取样源必须在胶囊之外，否则绘制视图会递归读取自身。
    if (isInViewSubtree(this, target)) return null
    targetRef = WeakReference(target)
    needsRecording = true
    return target
  }

  private fun canSample(target: View): Boolean =
    target.isAttachedToWindow && target.isShown && target.width > 0 && target.height > 0

  private fun updateSampleBeforeDraw() {
    if (Build.VERSION.SDK_INT < 33 || !isShown || !isHardwareAccelerated || failed ||
      width <= 0 || height <= 0
    ) return
    val hadTarget = targetRef != null
    val target = sampleTarget()
    if (target == null) {
      if (hadTarget) invalidate()
      return
    }
    // 数据、颜色和非 RN 滚动也会使内容视图失效。仅比较相对位置，避免重录同步移位的窗格。
    if (needsRecording || target.isDirty || renderer?.geometryChanged(this, target) != false) {
      needsRecording = true
      invalidate()
    }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (Build.VERSION.SDK_INT >= 33 && canvas.isHardwareAccelerated && !failed) {
      val target = sampleTarget()
      if (target != null && width > 0 && height > 0) {
        try {
          val sampler = renderer ?: DockSampleRenderer(resources.displayMetrics.density).also {
            renderer = it
          }
          val record = needsRecording
          needsRecording = false
          sampler.draw(canvas, this, target, record)
          return
        } catch (_: RuntimeException) {
          // 渲染器拒绝着色或目标下线时，仅当前视图降级。
          failed = true
          renderer?.release()
          renderer = null
        }
      }
    }
    canvas.drawColor(fallbackColor)
  }
}

private fun isInViewSubtree(view: View?, root: View): Boolean {
  var current = view
  while (current != null) {
    if (current === root) return true
    current = current.parent as? View
  }
  return false
}

@RequiresApi(33)
private class DockSampleRenderer(private val density: Float) {
  private val node = RenderNode("T3DockSample")
  private val hostLocation = IntArray(2)
  private val targetLocation = IntArray(2)
  private val padding = ceil(12 * density).toInt()
  private var width = 0
  private var height = 0
  private var targetWidth = 0
  private var targetHeight = 0
  private var offsetX = 0
  private var offsetY = 0
  private val lens = RuntimeShader(
    """
    uniform shader backdrop;
    uniform float2 origin;
    uniform float2 size;
    uniform float density;

    half4 main(float2 pos) {
      float radius = size.y * 0.5;
      float2 fromCenter = pos - origin - size * 0.5;
      float straight = max(0.0, size.x * 0.5 - radius);
      float2 edge = float2(fromCenter.x - clamp(fromCenter.x, -straight, straight), fromCenter.y);
      float edgeDistance = length(edge);
      float rim = smoothstep(radius - 8.0 * density, radius, edgeDistance);
      float2 offset = edge / max(1.0, edgeDistance) * rim * 2.5 * density;
      return backdrop.eval(pos - offset);
    }
    """.trimIndent()
  )

  fun geometryChanged(host: View, target: View): Boolean {
    host.getLocationInWindow(hostLocation)
    target.getLocationInWindow(targetLocation)
    return width != host.width || height != host.height ||
      targetWidth != target.width || targetHeight != target.height ||
      offsetX != targetLocation[0] - hostLocation[0] ||
      offsetY != targetLocation[1] - hostLocation[1]
  }

  fun draw(canvas: Canvas, host: View, target: View, needsRecording: Boolean) {
    val geometryChanged = geometryChanged(host, target)
    if (needsRecording || geometryChanged || !node.hasDisplayList()) record(host, target)
    canvas.drawRenderNode(node)
  }

  private fun record(host: View, target: View) {
    if (width != host.width || height != host.height) {
      width = host.width
      height = host.height
      lens.setFloatUniform("origin", padding.toFloat(), padding.toFloat())
      lens.setFloatUniform("size", width.toFloat(), height.toFloat())
      lens.setFloatUniform("density", density)
      val blur = RenderEffect.createBlurEffect(4 * density, 4 * density, Shader.TileMode.CLAMP)
      val refraction = RenderEffect.createRuntimeShaderEffect(lens, "backdrop")
      node.setPosition(-padding, -padding, width + padding, height + padding)
      node.setRenderEffect(RenderEffect.createChainEffect(refraction, blur))
    }

    targetWidth = target.width
    targetHeight = target.height
    offsetX = targetLocation[0] - hostLocation[0]
    offsetY = targetLocation[1] - hostLocation[1]
    val recording = node.beginRecording()
    try {
      recording.translate((offsetX + padding).toFloat(), (offsetY + padding).toFloat())
      target.draw(recording)
    } finally {
      node.endRecording()
    }
  }

  fun release() {
    node.discardDisplayList()
  }
}
