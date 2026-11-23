import { requireOptionalNativeModule } from "expo";

import type { LocalFileMove } from "./localFileMove";

export const localFileMove = requireOptionalNativeModule<LocalFileMove>("T3LocalFileMove");
