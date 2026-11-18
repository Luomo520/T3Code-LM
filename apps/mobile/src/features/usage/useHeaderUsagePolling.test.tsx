import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { useHeaderUsagePolling } from "./useHeaderUsagePolling";

const state = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (value: string) => void) => {
      state.listeners.add(listener);
      return { remove: () => state.listeners.delete(listener) };
    },
  },
}));

it("keeps one subscription across pending-data renders and reads the latest callbacks", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  state.listeners.clear();
  const root = createRoot(document.createElement("div"));
  onTestFinished(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  function Probe(props: { identity: string; refresh: () => void; enter: () => void }) {
    useHeaderUsagePolling(true, props.identity, props.refresh, props.enter);
    return null;
  }
  const first = { refresh: vi.fn(), enter: vi.fn() };
  const pending = { refresh: vi.fn(), enter: vi.fn() };
  const settled = { refresh: vi.fn(), enter: vi.fn() };
  act(() => root.render(<Probe identity="thread-a" {...first} />));
  expect(first.enter).toHaveBeenCalledTimes(1);
  act(() => root.render(<Probe identity="thread-a" {...pending} />));
  act(() => root.render(<Probe identity="thread-a" {...settled} />));
  expect(pending.enter).not.toHaveBeenCalled();
  expect(settled.enter).not.toHaveBeenCalled();
  expect(state.listeners.size).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(2000));
  expect(first.refresh).not.toHaveBeenCalled();
  expect(pending.refresh).not.toHaveBeenCalled();
  expect(settled.refresh).toHaveBeenCalledTimes(1);
  act(() => {
    for (const listener of state.listeners) listener("active");
  });
  expect(settled.enter).toHaveBeenCalledTimes(1);
  act(() => root.render(<Probe identity="thread-b" {...settled} />));
  expect(settled.enter).toHaveBeenCalledTimes(2);
  expect(state.listeners.size).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
});
