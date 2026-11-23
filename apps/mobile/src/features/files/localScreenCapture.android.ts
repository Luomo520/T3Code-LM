import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type { LocalScreenCapture } from "./localScreenCapture";

export const localScreenCapture =
  Number(Platform.Version) >= 29
    ? requireOptionalNativeModule<LocalScreenCapture>("T3LocalScreenCapture")
    : null;
