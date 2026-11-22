import { requireNativeView, requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type { AndroidDockSampleProps } from "./AndroidDockSample";

function resolveDockSample() {
  if (Number(Platform.Version) < 33) return null;
  try {
    if (!requireOptionalNativeModule("T3DockGlass")) return null;
    return requireNativeView<AndroidDockSampleProps>("T3DockGlass");
  } catch {
    return null;
  }
}

export const AndroidDockSample = resolveDockSample();
