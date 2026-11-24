package expo.modules.t3nativecontrols;

interface IT3ScreenshotService {
  void destroy() = 16777114;
  boolean capture(in ParcelFileDescriptor destination, int expectedUid) = 1;
}
