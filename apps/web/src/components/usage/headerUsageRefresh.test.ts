import { describe, expect, it } from "vite-plus/test";
import { HeaderUsageRefreshGate } from "./headerUsageRefresh";

describe("page entry refresh", () => {
  it("shares cooldown across page mounts and resume events, while isolating accounts", () => {
    const gate = new HeaderUsageRefreshGate();
    expect(gate.take("environment/codex", 0)).toBe(true);
    expect(gate.take("environment/codex", 100)).toBe(false);
    expect(gate.take("environment/codex", 29999)).toBe(false);
    expect(gate.take("other/codex", 29999)).toBe(true);
    expect(gate.take("environment/codex", 30000)).toBe(true);
    expect(gate.take("environment/codex", 30001)).toBe(false);
  });
});
