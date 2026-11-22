package expo.modules.t3nativecontrols

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3AppUpdateUrlTest {
  private val version = "0.2.2-4"
  private val name = "T3Code-LM-$version-android-arm64-apk.apk"
  private val root = "https://github.com/Luomo520/T3Code-LM/releases/download"

  @Test
  fun acceptsOnlyProductAndBuildTagsFromTheSameProductRelease() {
    for (tag in listOf("v0.2.2", "v0.2.2-2", "v0.2.2-4")) {
      assertTrue(T3AppUpdates.isReleaseAssetUrl("$root/$tag/$name", version, name))
    }
    for (address in listOf(
      "$root/v0.2.3/$name", "$root/v0.2.2-00/$name", "$root/v0.2.2/other.apk",
      "$root/v0.2.2/$name#fragment", "$root/v0.2.2/$name?x=y", "$root/v0.2.2/%2F$name",
      "https://other.example/Luomo520/T3Code-LM/releases/download/v0.2.2/$name"
    )) {
      assertFalse(address, T3AppUpdates.isReleaseAssetUrl(address, version, name))
    }
  }
}
