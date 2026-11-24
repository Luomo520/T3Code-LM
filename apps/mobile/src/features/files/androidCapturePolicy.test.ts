import { expect, it, vi } from "vite-plus/test";
const module = vi.hoisted(() => ({
  native: {} as { getEnvironmentPolicy?: ReturnType<typeof vi.fn> },
}));
vi.mock("./localScreenCapture", () => ({ localScreenCapture: module.native }));
import { readAndroidCapturePolicy } from "./androidCapturePolicy";

it("isolates backend and operation, and fails closed on an invalid permission", () => {
  expect(readAndroidCapturePolicy("old", "record-screen")).toBe("ask");
  module.native.getEnvironmentPolicy = vi.fn((env, kind) =>
    env === "home" && kind === "recording" ? "system" : "deny",
  );
  expect(readAndroidCapturePolicy("home", "record-screen")).toBe("system");
  expect(readAndroidCapturePolicy("home", "screenshot")).toBe("deny");
  expect(readAndroidCapturePolicy("other", "record-screen")).toBe("deny");
  module.native.getEnvironmentPolicy.mockReturnValue("unexpected");
  expect(readAndroidCapturePolicy("home", "record-screen")).toBe("deny");
  module.native.getEnvironmentPolicy.mockImplementation(() => {
    throw Error("unavailable");
  });
  expect(readAndroidCapturePolicy("home", "record-screen")).toBe("deny");
});
