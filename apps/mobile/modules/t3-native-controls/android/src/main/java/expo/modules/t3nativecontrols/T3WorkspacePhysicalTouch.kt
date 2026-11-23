package expo.modules.t3nativecontrols

import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent

object T3WorkspacePhysicalTouch {
  @Volatile
  private var physicalUpTime = -1L
  private var dispatchingPhysicalUp = false

  fun dispatch(event: MotionEvent, deliver: () -> Boolean): Boolean {
    if (event.actionMasked != MotionEvent.ACTION_UP) return deliver()
    val device = event.device
    // ADB 和 scrcpy 注入的触摸事件不来自真实触摸硬件。
    dispatchingPhysicalUp = device != null && !device.isVirtual &&
      event.isFromSource(InputDevice.SOURCE_TOUCHSCREEN)
    physicalUpTime = if (dispatchingPhysicalUp) event.eventTime else -1
    try {
      return deliver()
    } finally {
      dispatchingPhysicalUp = false
    }
  }

  fun duringPhysicalTouch(): Boolean = dispatchingPhysicalUp

  fun matchesPhysicalTouch(timestamp: Double): Boolean {
    val physicalTime = physicalUpTime
    return timestamp == physicalTime.toDouble() && physicalTime >= 0 &&
      SystemClock.uptimeMillis() - physicalTime in 0..1_000
  }
}
