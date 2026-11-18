import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { HeaderUsageDetailsDialog } from "./HeaderUsageDetailsDialog";
import type { UsageDetails } from "./headerUsageDetails";

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock("react-native", async () => {
  const { useEffect } = await import("react");
  const View = (props: { children?: ReactNode }) => <div>{props.children}</div>;
  return {
    View,
    ScrollView: View,
    Modal: (props: { children?: ReactNode }) => {
      useEffect(() => {
        lifecycle.mounts++;
        return () => {
          lifecycle.unmounts++;
        };
      }, []);
      return <div role="dialog">{props.children}</div>;
    },
    Pressable: (props: { children?: ReactNode; disabled?: boolean; onPress?: () => void }) => (
      <button disabled={props.disabled} onClick={props.onPress}>
        {props.children}
      </button>
    ),
    useWindowDimensions: () => ({ height: 800, width: 320, fontScale: 1 }),
  };
});
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));

it("keeps the modal and refresh control mounted during polling and a manual refresh", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  lifecycle.mounts = 0;
  lifecycle.unmounts = 0;
  const container = document.createElement("div");
  const root = createRoot(container);
  onTestFinished(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });
  let finish!: () => void;
  const request = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const refresh = vi.fn(() => request);
  const close = vi.fn();
  const edit = vi.fn();
  const details: UsageDetails = {
    provider: "Codex",
    source: null,
    notice: null,
    metrics: [],
    emptyText: "暂无请求记录。",
    rows: [
      { timestamp: "2026-11-14T10:00:00Z", tokens: "123,456,789", cache: "75.0%", speed: "150.0" },
    ],
  };
  const render = (value: UsageDetails) =>
    root.render(
      <HeaderUsageDetailsDialog
        details={value}
        onClose={close}
        onEdit={edit}
        onRefresh={refresh}
      />,
    );
  act(() => render(details));
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "刷新",
  )!;
  act(() => button.click());
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe("刷新");
  act(() => render({ ...details, rows: [{ ...details.rows[0]!, tokens: "234,567,890" }] }));
  expect(
    [...container.querySelectorAll("button")].find((item) => item.textContent === "刷新"),
  ).toBe(button);
  expect(button.disabled).toBe(true);
  act(() => button.click());
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(lifecycle.mounts).toBe(1);
  expect(lifecycle.unmounts).toBe(0);
  expect(close).not.toHaveBeenCalled();
  await act(async () => {
    finish();
    await request;
  });
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe("刷新");
  expect(lifecycle.mounts).toBe(1);
});
