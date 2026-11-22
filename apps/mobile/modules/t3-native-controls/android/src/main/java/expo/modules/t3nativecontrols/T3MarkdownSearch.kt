package expo.modules.t3nativecontrols

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.text.Spanned
import android.text.style.ReplacementSpan
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.TextView
import kotlin.math.roundToInt

internal object T3MarkdownSearch {
  private const val HIGHLIGHT_MS = 4_000L

  fun reveal(row: View, body: View, terms: List<String>): Map<String, Float>? {
    if (!row.isAttachedToWindow || !body.isAttachedToWindow || !body.isShown) return null
    if (generateSequence(body) { it.parent as? View }.none { it === row }) return null
    val views = textViews(body).toList()
    val match =
      terms.firstNotNullOfOrNull { term ->
        views.firstNotNullOfOrNull { text -> rangeIn(text, term) }
      } ?: return null
    val (text, path) = match
    val bounds = RectF().also { path.computeBounds(it, true) }
    revealHorizontally(text, bounds)
    flashMatch(text, path)

    val density = row.resources.displayMetrics.density
    val relativeTop = inWindow(text)[1] - inWindow(row)[1] + bounds.top
    return mapOf("top" to relativeTop / density, "height" to bounds.height() / density)
  }

  private fun textViews(view: View): Sequence<TextView> = sequence {
    if (view.visibility != View.VISIBLE) return@sequence
    // 原生围栏的语言标题是同级控件，实际代码位于水平滚动容器内。
    if (view is TextView && view.parent?.javaClass?.simpleName != "CodeBlockContainerView") {
      yield(view)
    }
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        yieldAll(textViews(view.getChildAt(index)))
      }
    }
  }

  private data class Match(val text: TextView, val path: Path)

  private fun rangeIn(view: TextView, term: String): Match? {
    val layout = view.layout ?: return null
    val rendered = layout.text
    var start = rendered.indexOf(term, ignoreCase = true)
    if (start < 0) return null
    var end = start + term.length
    // 链接胶囊会用替代 span 绘制整段标签，使用其实际可见范围。
    val spanned = rendered as? Spanned
    spanned?.getSpans(start, end, ReplacementSpan::class.java)?.firstOrNull()?.let { span ->
      start = minOf(start, spanned.getSpanStart(span))
      end = maxOf(end, spanned.getSpanEnd(span))
    }
    val line = layout.getLineForOffset(start)
    end = minOf(end, layout.getLineVisibleEnd(line))
    if (end <= start) return null
    val path = Path()
    layout.getSelectionPath(start, end, path)
    path.offset(
      (view.totalPaddingLeft - view.scrollX).toFloat(),
      (view.totalPaddingTop - view.scrollY).toFloat()
    )
    if (path.isEmpty) return null
    return Match(view, path)
  }

  private fun inWindow(view: View) = IntArray(2).also { view.getLocationInWindow(it) }

  private fun revealHorizontally(text: TextView, bounds: RectF) {
    var parent = text.parent
    while (parent is View && parent !is HorizontalScrollView) parent = parent.parent
    val scroller = parent as? HorizontalScrollView ?: return
    val origin = inWindow(text)[0] - inWindow(scroller)[0]
    val left = origin + bounds.left
    val right = origin + bounds.right
    val padding = 8 * text.resources.displayMetrics.density
    val limit = scroller.width - padding
    val delta = when {
      left < padding || bounds.width() > limit - padding -> left - padding
      right > limit -> right - limit
      else -> return
    }
    scroller.scrollBy(delta.roundToInt(), 0)
  }

  // 覆盖层随原文本滚动，既有选择范围、复制内容、链接与代码操作都由原视图处理。
  private fun flashMatch(view: TextView, path: Path) {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x66FFB000 }
    val marker = object : Drawable() {
      override fun draw(canvas: Canvas) = canvas.drawPath(path, paint)
      override fun setAlpha(alpha: Int) { paint.alpha = alpha }
      override fun setColorFilter(filter: ColorFilter?) { paint.colorFilter = filter }
      @Suppress("DEPRECATION")
      override fun getOpacity() = PixelFormat.TRANSLUCENT
    }
    val bounds = RectF().also { path.computeBounds(it, true) }
    marker.setBounds(
      kotlin.math.floor(bounds.left).toInt(),
      kotlin.math.floor(bounds.top).toInt(),
      kotlin.math.ceil(bounds.right).toInt(),
      kotlin.math.ceil(bounds.bottom).toInt()
    )
    view.overlay.add(marker)
    view.postDelayed({ view.overlay.remove(marker) }, HIGHLIGHT_MS)
  }
}
