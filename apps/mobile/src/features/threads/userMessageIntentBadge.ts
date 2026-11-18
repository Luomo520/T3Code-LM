import type { OrchestrationV2UserMessageInputIntent } from "@t3tools/contracts";

export interface UserMessageIntentBadgePresentation {
  readonly label: string;
  readonly accessibilityLabel: string;
}

export function resolveUserMessageIntentBadge(
  intent: OrchestrationV2UserMessageInputIntent | undefined,
  unread = false,
): UserMessageIntentBadgePresentation | null {
  if (unread && (intent === "steer" || intent === "promoted_queued_to_steer")) {
    return {
      label: "Steer · waiting to be read",
      accessibilityLabel:
        "Steer waiting for the agent to read it after the running command finishes",
    };
  }
  switch (intent) {
    case "steer":
      return {
        label: "调整当前任务",
        accessibilityLabel: "已调整当前轮次",
      };
    case "promoted_queued_to_steer":
      return {
        label: "调整当前任务",
        accessibilityLabel: "原为排队消息，后提升为调整当前轮次",
      };
    case "queued_turn":
    case "turn_start":
    case undefined:
      return null;
  }
}
