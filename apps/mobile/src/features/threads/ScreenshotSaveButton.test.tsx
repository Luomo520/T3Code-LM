import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  refresh: vi.fn(async () => "https://t3.example/api/assets/token/image-1.png"),
  enqueue: vi.fn(async () => "screenshot-download"),
  read: vi.fn(async () => ({ status: "downloaded", bytesDownloaded: 67 })),
  saveToLibrary: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { onPress: () => void; label: string; loading: boolean }) => (
    <button disabled={props.loading} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../lib/appState", () => ({ useAppActive: () => true }));
vi.mock("../../lib/systemFileDownload", () => ({
  enqueueFileDownload: state.enqueue,
  readFileDownload: state.read,
}));
vi.mock("../../state/assets", () => ({ useRefreshAssetUrl: () => state.refresh }));
vi.mock("../../state/mediaActions", () => ({
  useMediaActions: () => ({ actions: [{ id: "save-image", run: state.saveToLibrary }] }),
}));

import { ScreenshotSaveButton } from "./ScreenshotSaveButton";

it("starts platform saving only on a local save gesture", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ScreenshotSaveButton
          environmentId={EnvironmentId.make("nas")}
          resource={{
            _tag: "tool-output-image",
            threadId: ThreadId.make("thread"),
            itemId: TurnItemId.make("shot"),
            index: 0,
          }}
          fileName="截图-shot.png"
        />,
      );
    });
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.saveToLibrary).not.toHaveBeenCalled();
    const save = container.querySelector("button");
    expect(save?.textContent).toBe("保存到我的设备");
    await act(async () => save?.click());
    if (process.env.T3_MOBILE_TEST_PLATFORM === "android") {
      expect(state.enqueue).toHaveBeenCalledExactlyOnceWith(
        "https://t3.example/api/assets/token/image-1.png",
        "截图-shot.png",
      );
      expect(state.read).toHaveBeenCalledWith("screenshot-download");
      expect(container.textContent).toContain("已保存到 Download/t3code");
    } else {
      expect(state.saveToLibrary).toHaveBeenCalledOnce();
    }
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
