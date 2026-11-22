import * as Electron from "electron";

import {
  createTranslator,
  resolveSystemLocale,
  type Locale,
  type T3zhDict,
} from "./t3zh-runtime.ts";
import desktopDict from "./zh-CN.desktop.json" with { type: "json" };

export interface DesktopTranslator {
  readonly locale: Locale;
  readonly t: (value: string) => string;
}

export function createDesktopTranslator(
  languages: readonly string[],
  dict: T3zhDict = desktopDict,
): DesktopTranslator {
  const locale = resolveSystemLocale(languages);
  if (locale !== "zh-CN") return { locale, t: (value) => value };
  const translate = createTranslator(dict);
  return { locale, t: (value) => (typeof value === "string" ? translate(value) : value) };
}

/** 系统首选语言列表（`app.getPreferredSystemLanguages()`）；读不到时返回空列表，解析为 en。 */
export function readSystemLanguages(): string[] {
  try {
    const languages: unknown = Electron.app.getPreferredSystemLanguages();
    return Array.isArray(languages)
      ? languages.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function desktopTranslatorForLanguage(
  language: string | undefined,
  systemLanguages?: readonly string[],
): DesktopTranslator {
  const preference = language ?? "zh";
  if (preference === "system") {
    return createDesktopTranslator(systemLanguages ?? readSystemLanguages());
  }
  if (preference === "zh") return createDesktopTranslator(["zh-CN"]);
  return { locale: "en", t: (value) => value };
}
