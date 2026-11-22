import type { OrchestrationV2MessageClientOrigin } from "@t3tools/contracts";
import * as Context from "effect/Context";

// 只由已通过认证的消息入口设置，避免把来源当成消息命令的输入字段。
export const MessageClientOrigin = Context.Reference<
  OrchestrationV2MessageClientOrigin | undefined
>("t3/orchestration-v2/MessageClientOrigin", { defaultValue: () => undefined });
