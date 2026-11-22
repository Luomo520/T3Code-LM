package expo.modules.t3nativecontrols;

interface IT3ApkInstallService {
  void destroy() = 16777114;
  ParcelFileDescriptor openInstallStream(long sizeBytes) = 1;
  String awaitInstallResult() = 2;
}
