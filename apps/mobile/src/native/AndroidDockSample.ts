import type { ComponentType } from "react";
import type { ViewProps } from "react-native";

export interface AndroidDockSampleProps extends ViewProps {
  readonly targetNativeId: string;
  readonly fallbackColor: number;
  readonly contentRevision: string;
}

export const AndroidDockSample: ComponentType<AndroidDockSampleProps> | null = null;
