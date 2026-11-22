import { beforeEach, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  sdk: 33,
  module: vi.fn(),
  view: vi.fn(),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: native.module,
  requireNativeView: native.view,
}));

vi.mock("react-native", () => ({
  Platform: {
    get Version() {
      return native.sdk;
    },
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  native.sdk = 33;
});

it("leaves older Android versions on the JavaScript tint", async () => {
  native.sdk = 32;
  expect((await import("./AndroidDockSample.android")).AndroidDockSample).toBeNull();
  expect(native.module).not.toHaveBeenCalled();
});

it("keeps the previous APK usable when it is missing the native sampler", async () => {
  native.module.mockReturnValue(null);
  expect((await import("./AndroidDockSample.android")).AndroidDockSample).toBeNull();
  expect(native.view).not.toHaveBeenCalled();
});

it("uses the linked sampler on a supported Android version", async () => {
  const view = () => null;
  native.module.mockReturnValue({});
  native.view.mockReturnValue(view);
  expect((await import("./AndroidDockSample.android")).AndroidDockSample).toBe(view);
  expect(native.view).toHaveBeenCalledWith("T3DockGlass");
});

it("leaves a readable tint if the native view registration fails", async () => {
  native.module.mockReturnValue({});
  native.view.mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect((await import("./AndroidDockSample.android")).AndroidDockSample).toBeNull();
});
