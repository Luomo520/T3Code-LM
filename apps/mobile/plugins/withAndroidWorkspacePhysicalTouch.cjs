const { withMainActivity } = require("expo/config-plugins");

const ACTIVITY = "class MainActivity : ReactActivity() {";
const TOUCH_DISPATCH = `
  override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
    return expo.modules.t3nativecontrols.T3WorkspacePhysicalTouch.dispatch(event) {
      super.dispatchTouchEvent(event)
    }
  }
`;

module.exports = function withAndroidWorkspacePhysicalTouch(config) {
  return withMainActivity(config, (nextConfig) => {
    const { contents, language } = nextConfig.modResults;
    if (contents.includes("T3WorkspacePhysicalTouch.dispatch")) return nextConfig;
    if (language !== "kt" || !contents.includes(ACTIVITY)) {
      throw new Error(
        "withAndroidWorkspacePhysicalTouch: MainActivity must use the Kotlin template.",
      );
    }
    nextConfig.modResults.contents = contents.replace(ACTIVITY, ACTIVITY + TOUCH_DISPATCH);
    return nextConfig;
  });
};
