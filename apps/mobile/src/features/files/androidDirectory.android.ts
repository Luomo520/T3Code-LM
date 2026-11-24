import { requireOptionalNativeModule } from "expo";

import type { AndroidDirectoryModule } from "./androidDirectory";

export const androidDirectory =
  requireOptionalNativeModule<AndroidDirectoryModule>("T3LocalDirectory");
