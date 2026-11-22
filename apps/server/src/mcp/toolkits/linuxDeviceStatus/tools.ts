import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";
import { readTargets } from "../../../fileExchange/config.ts";
import * as FileExchange from "../../../fileExchange/FileExchange.ts";
import { linuxDeviceChecks } from "../../../fileExchange/LinuxDeviceStatus.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const deviceId = Schema.String;

const LinuxDeviceStatusTool = Tool.make("t3_linux_device_status", {
  description:
    "Read one status item from an administrator-configured Linux device assigned to the calling thread's workspace. Use system_version for the Linux kernel version, available_space for available bytes on the root filesystem, or uptime for seconds since boot.",
  parameters: Schema.Struct({
    deviceId,
    check: Schema.Literals(linuxDeviceChecks),
  }),
  success: Schema.Union([
    Schema.Struct({
      deviceId,
      check: Schema.Literal("system_version"),
      kernelVersion: Schema.String,
    }),
    Schema.Struct({
      deviceId,
      check: Schema.Literal("available_space"),
      availableBytes: Schema.Int,
    }),
    Schema.Struct({
      deviceId,
      check: Schema.Literal("uptime"),
      uptimeSeconds: Schema.Int,
    }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    Project.ProjectService,
    FileExchange.FileExchange,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, () =>
    readTargets().some((target) => target.diagnosticsSshAlias !== undefined),
  );

export const LinuxDeviceStatusToolkit = Toolkit.make(LinuxDeviceStatusTool);
