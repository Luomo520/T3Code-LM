package expo.modules.t3nativecontrols;

interface IT3ApkInstallService {
  void destroy() = 16777114;
  ParcelFileDescriptor openInstallStream(long sizeBytes, int expectedUid, String packageName) = 3;
  String awaitInstallResult() = 2;
}
