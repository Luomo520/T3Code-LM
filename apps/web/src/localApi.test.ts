import { type ConfirmDialogOptions, type ContextMenuItem } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
const dismissContextMenuMock = vi.fn<() => void>();

const requestConfirmDialogMock =
  vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>();

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
  dismissContextMenu: dismissContextMenuMock,
}));

vi.mock("./confirmDialog", () => ({
  requestConfirmDialog: requestConfirmDialogMock,
}));

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function testWindow(): Window & typeof globalThis {
  return globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (globalThis.window === undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
  Reflect.deleteProperty(testWindow(), "desktopBridge");
  Object.defineProperty(testWindow(), "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalApi", () => {
  it.each(["en", "system", "zh-CN"])(
    "uses legacy language %s before the first settings save",
    async (language) => {
      testWindow().localStorage.setItem("t3code-zh.locale", language);
      const { createLocalApi } = await import("./localApi");
      await expect(createLocalApi().persistence.getClientSettings()).resolves.toMatchObject({
        language: language === "zh-CN" ? "zh" : language,
      });
    },
  );

  it("uses the legacy language when an older browser settings record has no language field", async () => {
    testWindow().localStorage.setItem("t3code-zh.locale", "en");
    testWindow().localStorage.setItem(
      "t3code:client-settings:v1",
      JSON.stringify({ wordWrap: false }),
    );
    const { createLocalApi } = await import("./localApi");
    await expect(createLocalApi().persistence.getClientSettings()).resolves.toMatchObject({
      language: "en",
      wordWrap: false,
    });
  });

  it("keeps the saved language even when a legacy preference remains", async () => {
    testWindow().localStorage.setItem("t3code-zh.locale", "en");
    const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts");
    const { createLocalApi } = await import("./localApi");
    const persistence = createLocalApi().persistence;
    await persistence.setClientSettings({ ...DEFAULT_CLIENT_SETTINGS, language: "ja" });
    await expect(persistence.getClientSettings()).resolves.toMatchObject({ language: "ja" });
  });
  it("fails closed in a browser when no themed host is available", async () => {
    requestConfirmDialogMock.mockReturnValue(undefined);
    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().dialogs.confirm("Delete this thread?")).resolves.toBe(false);
  });
});
