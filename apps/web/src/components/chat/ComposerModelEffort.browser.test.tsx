import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  ComposerEffortColumn,
  ComposerPickerFooter,
  ComposerPickerPermissionsMenu,
  describeComposerEffort,
} from "./ComposerModelEffort";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { markOpenToPermissions } from "./composerEventScope";
import { resolveRuntimeModeOptions, runtimeModeOptions } from "./runtimeModeConfig";
import type { TraitsSelectionInput } from "./TraitsPicker";

const provider = ProviderDriverKind.make("acpRegistry");
const instanceId = ProviderInstanceId.make("devin");

// Shaped like Devin over ACP: its session mode comes first, and its reasoning id is its own.
const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "fusion",
    name: "Fusion (Claude Opus 5.5 Medium + SWE-2 High)",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "mode",
          label: "Session Mode",
          type: "select",
          currentValue: "bypass",
          options: [
            { id: "code", label: "Code" },
            { id: "plan", label: "Plan" },
            { id: "bypass", label: "Bypass Permissions" },
          ],
        },
        {
          id: "thought_level",
          label: "Thinking",
          type: "select",
          role: "reasoning",
          currentValue: "medium",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
        },
        {
          id: "speed",
          label: "Speed",
          type: "select",
          currentValue: "standard",
          options: [
            { id: "standard", label: "Standard" },
            { id: "fast", label: "Fast" },
          ],
        },
        { id: "auto_approve", label: "Auto-approve tools", type: "boolean", currentValue: false },
      ],
    }),
  },
];

const instanceEntries = deriveProviderInstanceEntries([
  {
    instanceId,
    driver: provider,
    displayName: "Devin",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
  },
]);
const modelOptionsByInstance = new Map([[instanceId, models]]);
const permissions = resolveRuntimeModeOptions(runtimeModeOptions, undefined);

function traitsInput(
  modelOptions: ReadonlyArray<ProviderOptionSelection>,
  onModelOptionsChange: (next: ReadonlyArray<ProviderOptionSelection> | undefined) => void,
): TraitsSelectionInput {
  return {
    provider,
    instanceId,
    models,
    model: "fusion",
    modelOptions,
    onModelOptionsChange,
  };
}

function Column() {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const traits = traitsInput(options, (next) => setOptions(next ?? []));
  return (
    <>
      <div data-model-picker-effort>
        <ComposerEffortColumn traits={traits} />
      </div>
      <p role="status">{describeComposerEffort(traits, "bars", "sm").suffix}</p>
    </>
  );
}

function Picker({ save }: { save: (value: string | null) => Promise<void> }) {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [mode, setMode] = useState<RuntimeMode>("full-access");
  const traits = traitsInput(options, (next) => setOptions(next ?? []));
  return (
    <div className="fixed right-4 bottom-4">
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model="fusion"
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={() => {}}
        headerAction={
          <ComposerPickerPermissionsMenu
            runtimeMode={mode}
            options={permissions}
            onChange={setMode}
          />
        }
        footer={<ComposerPickerFooter traits={traits} />}
        effortColumn={
          <ComposerEffortColumn
            traits={traits}
            defaultEffort={{
              saved,
              save: async (value) => {
                await save(value);
                setSaved(value);
              },
            }}
          />
        }
      />
    </div>
  );
}

it("draws an agent's reasoning as bars and keeps its mode out of the levels", async () => {
  await using screen = await render(<Column />, { router: false }); // no routes involved
  const status = screen.getByRole("status");
  expect(status.element().querySelector("[data-composer-effort-glyph]")).not.toBeNull();
  await expect.element(status).toHaveTextContent("");

  const slider = screen.getByRole("slider", { name: "思考强度" });
  await expect.element(slider).toHaveAttribute("max", "2");
  await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium");
  await expect
    .element(screen.getByRole("button", { name: /^默认思考强度：/ }))
    .not.toBeInTheDocument();

  const speed = screen.getByRole("button", { name: "Speed: Standard" });
  speed.element().focus();
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("menuitemradio", { name: "Standard" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await expect.element(speed).toHaveFocus();

  await userEvent.click(screen.getByText("Auto-approve tools"));
  await expect
    .element(screen.getByRole("switch", { name: "Auto-approve tools" }))
    .toHaveAttribute("aria-checked", "true");

  await userEvent.click(screen.getByRole("button", { name: "Session Mode: Bypass Permissions" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Plan" }));
  await expect
    .element(screen.getByRole("button", { name: "Session Mode: Plan" }))
    .toBeInTheDocument();
  await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium");
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
});

it("saves and clears the desktop default independently of the session slider", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const save = vi.fn(async (_value: string | null) => {});
  await using screen = await render(<Picker save={save} />, { router: false });
  const picker = screen.getByRole("button", { name: "Choose model" });
  await picker.click();

  const slider = page.getByRole("slider", { name: "思考强度" });
  const editDefault = page.getByRole("button", { name: /^默认思考强度：/ });
  const menu = page.getByRole("menu");
  const recommended = menu.getByRole("menuitemradio", { name: "使用模型推荐值" });
  const high = menu.getByRole("menuitemradio", { name: "High", exact: true });
  await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium");
  await expect.element(editDefault).toHaveTextContent("默认：Medium");
  await editDefault.click();
  await expect.element(recommended).toHaveAttribute("aria-checked", "true");
  await high.click();
  await expect.element(menu).not.toBeInTheDocument();
  expect(save.mock.calls).toEqual([["high"]]);
  await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium");
  await expect.element(editDefault).toHaveTextContent("默认：High");

  slider.element().focus();
  await userEvent.keyboard("{Home}");
  await expect.element(slider).toHaveAttribute("aria-valuetext", "Low");
  const reset = page.getByRole("button", { name: "恢复默认：High" });
  await reset.click();
  await expect.element(slider).toHaveAttribute("aria-valuetext", "High");
  expect(save.mock.calls).toEqual([["high"]]);

  await page.getByRole("button", { name: "关闭模型面板" }).click();
  await expect.element(slider).not.toBeInTheDocument();
  await picker.click();
  await editDefault.click();
  await expect.element(high).toHaveAttribute("aria-checked", "true");
  await recommended.click();
  await expect.element(menu).not.toBeInTheDocument();
  expect(save.mock.calls).toEqual([["high"], [null]]);
  await expect.element(slider).toHaveAttribute("aria-valuetext", "High");

  await page.getByRole("button", { name: "恢复默认：Medium" }).click();
  await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium");
  expect(save.mock.calls).toEqual([["high"], [null]]);
});

it("shows the reasoning sweep only inside the fill at every level in a narrow picker", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(320, 580);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await using screen = await render(<Picker save={async () => {}} />, { router: false });
  await screen.getByRole("button", { name: "Choose model" }).click();
  const slider = page.getByRole("slider", { name: "思考强度" });
  const range = slider.element() as HTMLInputElement;
  const track = range.parentElement!;
  const rail = track.querySelector<HTMLElement>('[data-reasoning-slider-part="rail"]')!;
  const fill = rail.querySelector('[data-reasoning-slider-part="fill"]')!;
  const stops = track.querySelectorAll('[data-reasoning-slider-part="stops"] i');
  const sweepStyle = () => getComputedStyle(fill, "::before");
  const expectSweep = async (value: string) => {
    await expect.element(slider).toHaveAttribute("aria-valuetext", value);
    await expect.poll(() => sweepStyle().animationName).toBe("reasoning-effort-flow");
    await expect.poll(() => sweepStyle().animationPlayState).toBe("running");
    expect(getComputedStyle(rail).backgroundColor).toBe("rgb(62, 64, 82)");
    expect(getComputedStyle(rail, "::before").animationName).toBe("none");
    expect(getComputedStyle(rail, "::before").backgroundImage).toBe("none");
    const stop = stops[Number(range.value)]!.getBoundingClientRect();
    expect(fill.getBoundingClientRect().right).toBeCloseTo(stop.left + stop.width / 2, 0);
  };

  await expectSweep("Medium");
  range.focus();
  await userEvent.keyboard("{Home}");
  await expectSweep("Low");
  const firstPosition = sweepStyle().transform;
  await expect.poll(() => sweepStyle().transform).not.toBe(firstPosition);
  const screenshot = await page.screenshot({ element: rail, save: false });
  const image = new Image();
  image.src = screenshot.startsWith("data:") ? screenshot : `data:image/png;base64,${screenshot}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const pixels = canvas.getContext("2d")!;
  pixels.drawImage(image, 0, 0);
  const pixelAt = (x: number) =>
    Array.from(pixels.getImageData(x, Math.floor(canvas.height / 2), 1, 1).data);
  const leadingPixel = pixelAt(Math.round((5 * canvas.width) / rail.getBoundingClientRect().width));
  expect(leadingPixel[0]).toBeGreaterThan(150);
  expect(leadingPixel[0]).toBeLessThan(235);
  expect(leadingPixel[2]).toBeGreaterThan(220);
  expect(pixelAt(Math.floor(canvas.width * 0.75))).toEqual([62, 64, 82, 255]);

  {
    const browser = cdp();
    await browser.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await using _motion = {
      async [Symbol.asyncDispose]() {
        await browser.send("Emulation.setEmulatedMedia", { features: [] });
      },
    };
    await expect.poll(() => sweepStyle().animationName).toBe("none");
    expect(sweepStyle().backgroundImage).toContain("linear-gradient");
    expect(getComputedStyle(rail, "::before").backgroundImage).toBe("none");
  }
  await expectSweep("Low");

  {
    using _visibility = {
      [Symbol.dispose]: () => {
        rail.hidden = false;
      },
    };
    rail.hidden = true;
    await expect.poll(() => sweepStyle().animationPlayState).toBe("paused");
  }
  const rangeBounds = range.getBoundingClientRect();
  const medium = stops[1]!.getBoundingClientRect();
  await slider.click({
    position: { x: medium.left + medium.width / 2 - rangeBounds.left, y: rangeBounds.height / 2 },
  });
  await expectSweep("Medium");
  range.focus();
  await userEvent.keyboard("{End}");
  await expectSweep("High");
  await page.getByRole("button", { name: "关闭模型面板" }).click();
  await expect.element(slider).not.toBeInTheDocument();
});

it("keeps the narrow-window default usable and retries a failed save", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(360, 640);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const save = vi
    .fn(async (_value: string | null) => {})
    .mockRejectedValueOnce(new Error("Save failed"));
  await using screen = await render(<Picker save={save} />, { router: false });
  await screen.getByRole("button", { name: "Choose model" }).click();

  const editDefault = page.getByRole("button", { name: /^默认思考强度：/ });
  const menu = page.getByRole("menu");
  const high = menu.getByRole("menuitemradio", { name: "High", exact: true });
  const alert = page.getByRole("alert");
  await editDefault.click();
  await expect.element(high).toBeVisible();
  await expect
    .poll(() => {
      const { top, right, bottom, left } = menu.element().getBoundingClientRect();
      return top >= 0 && right <= window.innerWidth && bottom <= window.innerHeight && left >= 0;
    })
    .toBe(true);
  await high.click();
  await expect.element(alert).toBeVisible();
  await expect.element(page.getByRole("button", { name: "恢复默认：Medium" })).toBeVisible();
  await expect
    .element(page.getByRole("slider", { name: "思考强度" }))
    .toHaveAttribute("aria-valuetext", "Medium");

  await editDefault.click();
  await expect
    .element(menu.getByRole("menuitemradio", { name: "使用模型推荐值" }))
    .toHaveAttribute("aria-checked", "true");
  await high.click();
  await expect.element(page.getByRole("button", { name: "恢复默认：High" })).toBeVisible();
  await expect.element(alert).not.toBeInTheDocument();
  expect(save.mock.calls).toEqual([["high"], ["high"]]);
});

it("keeps permissions reachable beside search in the narrow picker header", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(320, 580);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await using screen = await render(<Picker save={async () => {}} />, { router: false });
  const picker = screen.getByRole("button", { name: "Choose model" });
  markOpenToPermissions(picker.element() as HTMLButtonElement);
  await picker.click();

  const fullAccess = page.getByRole("menuitemradio", { name: "Full access" });
  await expect.element(fullAccess).toHaveFocus();
  await expect.element(fullAccess).toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard("{ArrowLeft}{Enter}");
  const mode = page.getByRole("button", { name: "Permissions: Auto" });
  const search = page.getByRole("button", { name: "搜索模型" });
  const close = page.getByRole("button", { name: "关闭模型面板" });
  await expect.element(mode).toHaveFocus();
  const header = mode.element().closest("[data-model-picker-header]");
  expect(header).toContainElement(search.element());
  expect(header).toContainElement(close.element());
  expect(mode.element().getBoundingClientRect().left).toBeGreaterThanOrEqual(
    search.element().getBoundingClientRect().right,
  );
  expect(mode.element().getBoundingClientRect().right).toBeLessThan(window.innerWidth);
  expect(
    mode
      .element()
      .closest("[data-model-picker-popup]")
      ?.querySelector("[data-model-picker-footer]"),
  ).toBeNull();

  await search.click();
  await expect.element(page.getByRole("combobox")).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(close).not.toBeInTheDocument();
  await expect.element(picker).toHaveFocus();
});
