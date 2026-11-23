import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { WindowsCompanionSettings } from "./WindowsCompanionSettings";

const server = vi.hoisted(() => ({
  enabled: false,
  pair: vi.fn(),
}));

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: EnvironmentId.make("companion-test"),
      label: "Test environment",
      serverConfig: { environment: { capabilities: { windowsCompanion: true } } },
    };
    return {
      scope: { kind: "environment" },
      connectedEnvironments: [environment],
      environments: [environment],
      targets: [],
      target: null,
    };
  }) as never,
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({ windowsCompanionEnabled: server.enabled })) as never,
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

vi.mock(import("~/state/windowsCompanion"), async (original) => {
  const actual = await original();
  const list = Atom.make(
    AsyncResult.success({
      devices: [
        {
          deviceId: "windows-test",
          name: "Windows test device",
          info: {
            hostname: "PC-TEST",
            gpu: "Sample Graphics",
            memory: "32 GiB",
            network1: "LAN · IP 192.0.2.1 · MAC 02-11-22-33-44-55",
          },
          online: false,
          lastSeen: "2026-11-23T01:00:00Z",
          detailsUpdatedAt: "2026-11-23T03:30:00Z",
          recentTasks: [
            {
              id: "task-test",
              threadId: "thread-test",
              action: "screenshot",
              status: "done",
              updatedAt: "2026-11-23T03:31:00Z",
            },
          ],
        },
      ],
    }),
  );
  return {
    ...actual,
    windowsCompanionList: (() => list) as never,
    windowsCompanionPair: { ...actual.windowsCompanionPair, run: server.pair },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("preserves device management when new pairing is turned off", async () => {
  server.enabled = false;
  server.pair.mockReset();
  await using screen = await render(<WindowsCompanionSettings />);

  await expect.element(screen.getByRole("heading", { name: "Windows test device" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Unpair" })).toBeVisible();
  await expect.element(screen.getByText("Sample Graphics")).not.toBeVisible();
  await userEvent.click(screen.getByText("Device details"));
  await expect.element(screen.getByText("PC-TEST")).toBeVisible();
  await expect.element(screen.getByText("Sample Graphics")).toBeVisible();
  await expect.element(screen.getByText("32 GiB")).toBeVisible();
  await expect
    .element(screen.getByText("LAN · IP 192.0.2.1 · MAC 02-11-22-33-44-55"))
    .toBeVisible();
  await expect.element(screen.getByText(/^Details updated/)).toBeVisible();
  await expect
    .element(screen.getByText("This Windows companion cannot install apps."))
    .toBeVisible();
  await userEvent.fill(
    screen.getByLabelText("Find a paired device by MAC address"),
    "02:11:22:33:44:55",
  );
  await expect
    .element(
      screen.getByText("Reported by Windows test device. Verify the device using its pairing."),
    )
    .toBeVisible();
  await userEvent.click(screen.getByText("Recent tasks"));
  await expect.element(screen.getByText("task-test")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Open original conversation" }))
    .toHaveAttribute("href", "/companion-test/thread-test");
  expect(screen.getByRole("button", { name: "Add Windows device" }).query()).toBeNull();
  expect(server.pair).not.toHaveBeenCalled();
});

it("creates a code only for an open pairing dialog and drops an earlier dialog's answer", async () => {
  server.enabled = true;
  server.pair.mockReset();
  const first = deferred<AsyncResult.Success<{ code: string; expiresAt: string }>>();
  const second = deferred<AsyncResult.Success<{ code: string; expiresAt: string }>>();
  server.pair.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

  await using screen = await render(<WindowsCompanionSettings />);
  using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-23T02:00:00Z"));
  const addDevice = screen.getByRole("button", { name: "Add Windows device" });
  expect(server.pair).not.toHaveBeenCalled();
  await userEvent.click(addDevice);
  await expect.element(page.getByRole("dialog", { name: "Pair a Windows device" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(addDevice).toHaveFocus();
  await userEvent.click(addDevice);

  await act(async () => {
    first.resolve(AsyncResult.success({ code: "earlier-code", expiresAt: "2026-11-23T02:01:00Z" }));
    second.resolve(
      AsyncResult.success({ code: "current-code", expiresAt: "2026-11-23T02:01:00Z" }),
    );
    await second.promise;
  });
  await expect.element(page.getByText("current-code")).toBeVisible();
  expect(page.getByText("earlier-code").query()).toBeNull();
  expect(server.pair).toHaveBeenCalledTimes(2);
});
