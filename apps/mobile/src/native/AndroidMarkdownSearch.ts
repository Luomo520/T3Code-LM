import { requireOptionalNativeModule } from "expo";
import type { ComponentRef } from "react";
import { findNodeHandle, Platform, View } from "react-native";

interface AndroidMarkdownSearchControls {
  readonly revealMarkdownSearchMatch?: (
    rowTag: number,
    bodyTag: number,
    terms: ReadonlyArray<string>,
  ) => Promise<{ readonly top: number; readonly height: number } | null>;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidMarkdownSearchControls>("T3NativeControls")
    : null;

export const canRevealAndroidMarkdownSearchMatch =
  typeof native?.revealMarkdownSearchMatch === "function";

export function revealAndroidMarkdownSearchMatch(
  row: ComponentRef<typeof View> | null | undefined,
  body: ComponentRef<typeof View> | null,
  terms: ReadonlyArray<string>,
) {
  const rowTag = row && findNodeHandle(row);
  const bodyTag = body && findNodeHandle(body);
  if (rowTag == null || bodyTag == null) return Promise.resolve(null);
  return native?.revealMarkdownSearchMatch?.(rowTag, bodyTag, terms) ?? Promise.resolve(null);
}
