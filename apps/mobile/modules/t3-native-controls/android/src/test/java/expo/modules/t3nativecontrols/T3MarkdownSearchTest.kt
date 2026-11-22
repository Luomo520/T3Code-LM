package expo.modules.t3nativecontrols

import android.app.Activity
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ClickableSpan
import android.view.View
import android.view.ViewGroup.LayoutParams
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class T3MarkdownSearchTest {
  @Test
  fun locatesRenderedLinkAndPreservesItsSpan() {
    Robolectric.buildActivity(Activity::class.java).setup().use { controller ->
      val activity = controller.get()
      val row = createRow(activity)
      val body = createRow(activity)
      row.addView(TextView(activity).apply { text = "匹配摘录 readme.md" })
      row.addView(body)
      val label = "readme.md"
      val content = SpannableString("第 1 行\n".repeat(60) + label)
      val link =
        object : ClickableSpan() {
          override fun onClick(widget: View) = Unit
        }
      content.setSpan(link, content.length - label.length, content.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      val original = TextView(activity).apply { text = content }
      body.addView(original)
      attach(activity, row)

      val match = T3MarkdownSearch.reveal(row, body, listOf(label))
      assertNotNull(match)
      val lastLine = original.layout.getLineForOffset(content.length - label.length)
      assertTrue(lastLine >= 60)
      assertTrue(match!!.getValue("top") > original.layout.getLineBottom(0))
      assertSame(link, (original.text as Spanned).getSpans(0, content.length, ClickableSpan::class.java).single())
      assertEquals(content.toString(), original.text.toString())
      assertNull(T3MarkdownSearch.reveal(body, row, listOf(label)))
    }
  }

  @Test
  fun revealsLineAndHorizontalPositionInsideLongCodeBlock() {
    Robolectric.buildActivity(Activity::class.java).setup().use { controller ->
      val activity = controller.get()
      val row = createRow(activity)
      val scroll = HorizontalScrollView(activity)
      val command = "pnpm run lint --fix"
      val code = TextView(activity).apply {
        text = "echo OK\n".repeat(65) + "x".repeat(160) + "  " + command
      }
      scroll.addView(code, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
      row.addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
      attach(activity, row)

      val before = code.text.toString()
      val match = T3MarkdownSearch.reveal(row, scroll, listOf(command))
      assertNotNull(match)
      assertTrue(match!!.getValue("top") > code.layout.getLineBottom(0))
      assertTrue(scroll.scrollX > 0)
      assertEquals(before, code.text.toString())
      assertNull(T3MarkdownSearch.reveal(row, scroll, listOf("未渲染的文件")))
    }
  }

  private fun createRow(activity: Activity) =
    LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

  private fun attach(activity: Activity, root: View) {
    activity.setContentView(root)
    val width = View.MeasureSpec.makeMeasureSpec(360, View.MeasureSpec.EXACTLY)
    val height = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
    root.measure(width, height)
    root.layout(0, 0, root.measuredWidth, root.measuredHeight)
  }
}
