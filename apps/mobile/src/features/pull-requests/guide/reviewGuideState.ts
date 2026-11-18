import type { PullRequestReviewGuideResult } from "@t3tools/contracts";

export function reviewGuideState(data: PullRequestReviewGuideResult | null) {
  const guide = data?.guide ?? null;
  return {
    guide,
    running: data?.run?._tag === "Running",
    stale: guide !== null && data?.currentHeadSha != null && guide.headSha !== data.currentHeadSha,
    failure:
      data?.run?._tag === "Failed" && data.run.headSha === data.currentHeadSha
        ? data.run.detail
        : null,
  };
}

export function guideNoticeState(state: {
  readonly data: PullRequestReviewGuideResult | null;
  readonly isPending: boolean;
  readonly running: boolean;
  readonly startError: string | null;
  readonly error: string | null;
}) {
  const { guide, stale, failure } = reviewGuideState(state.data);
  if (state.running) {
    return {
      kind: "writing" as const,
      title: "正在重写指南",
      description: guide
        ? "智能体更新指南时，你可以继续阅读现有内容。"
        : "智能体正在阅读更改并编写导览，你可以先离开，完成后再回来。",
      action: guide ? "Rewriting…" : "Writing guide…",
    };
  }
  const error = state.startError ?? failure;
  if (error) {
    return {
      kind: "failed" as const,
      title: "无法编写指南",
      description: error,
      action: "Try again",
    };
  }
  if (state.error) {
    return {
      kind: "unavailable" as const,
      title: "无法刷新指南",
      description: state.error,
      action: "Try again",
    };
  }
  if (!state.data) {
    return {
      kind: "loading" as const,
      title: "审查指南",
      description: "正在检查已保存的指南…",
      action: "Loading guide…",
    };
  }
  if (stale) {
    return {
      kind: "stale" as const,
      title: "此指南之后有新的更改",
      description: "你可以阅读旧指南，或基于最新更改重新编写。",
      action: "Rewrite guide",
    };
  }
  return {
    kind: guide ? ("ready" as const) : ("empty" as const),
    title: "审查指南",
    description:
      "通过代码摘录和重点说明，导览此次更改。",
    action: "Write guide",
  };
}
