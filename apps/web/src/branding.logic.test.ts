import { describe, expect, it } from "vite-plus/test";

import { resolveWindowTitle } from "./branding.logic";

const windowContext = {
  appDisplayName: "T3 Code (Beta)",
  projectTitle: "Project A",
  threadTitle: "First thread",
  desktop: true,
};

describe("Windows taskbar title", () => {
  it.each([
    ["app", ["T3 Code", "T3 Code", "T3 Code"]],
    [
      "project-thread",
      ["Project A / First thread", "Project A / Next thread", "Project B / Other thread"],
    ],
    ["thread", ["First thread", "Next thread", "Other thread"]],
    ["project", ["Project A", "Project A", "Project B"]],
  ] as const)("formats same-project and cross-project navigation in %s mode", (mode, titles) => {
    const input = { ...windowContext, windowsTaskbar: { mode, appBaseName: "T3 Code" } };

    expect([
      resolveWindowTitle(input),
      resolveWindowTitle({ ...input, threadTitle: "Next thread" }),
      resolveWindowTitle({ ...input, projectTitle: "Project B", threadTitle: "Other thread" }),
    ]).toEqual(titles);
  });

  it.each([
    ["project-thread", null, "First thread", "First thread"],
    ["project-thread", "Project A", null, "Project A"],
    ["project-thread", null, null, "T3 Code"],
    ["thread", "Project A", " ", "T3 Code"],
    ["project", " ", "First thread", "T3 Code"],
  ] as const)(
    "formats %s mode with project %s and thread %s",
    (mode, projectTitle, threadTitle, expected) => {
      expect(
        resolveWindowTitle({
          ...windowContext,
          projectTitle,
          threadTitle,
          windowsTaskbar: { mode, appBaseName: "T3 Code" },
        }),
      ).toBe(expected);
    },
  );

  it("keeps the screen reader title when explicitly enabled", () => {
    expect(
      resolveWindowTitle({
        ...windowContext,
        screenReader: { threadStatus: "Needs approval" },
        windowsTaskbar: { mode: "project", appBaseName: "T3 Code" },
      }),
    ).toBe("Needs approval: First thread - Project A");
  });

  it("keeps contextual titles on other platforms", () => {
    expect(resolveWindowTitle(windowContext)).toBe("Project A / First thread");
    expect(resolveWindowTitle({ ...windowContext, desktop: false })).toBe(
      "Project A / First thread - T3 Code (Beta)",
    );
  });
});
