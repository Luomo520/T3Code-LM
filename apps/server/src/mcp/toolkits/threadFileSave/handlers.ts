import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  OrchestratorMcpFailure,
  type AuthClientSession,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OpenMediaFile } from "../../../assets/MediaFile.ts";
import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import { EnvironmentAuth } from "../../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../../auth/SessionStore.ts";
import { getCompanionStore } from "../../../companion/store.ts";
import { ServerConfig } from "../../../config.ts";
import {
  readThreadFileHandoffStatus,
  stageThreadFileHandoff,
} from "../../../fileExchange/FileHandoff.ts";
import { isActiveRun } from "../../../orchestration-v2/ThreadManagementService.ts";
import { requireThreadScope } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { callerLinkOrigin } from "../../linkOrigin.ts";
import { assertLiveCaller, readCaller, unavailable } from "../../threadAccess.ts";
import { hasExplicitThreadFileSaveIntent, threadFileDestination } from "./intent.ts";
import { ThreadFileSaveToolkit } from "./tools.ts";
import { resolveWorkspaceOutput } from "./workspaceOutput.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const deviceChoiceId = "t3-file-save-target";

function selectedOption(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.length === 1 && typeof value[0] === "string" ? value[0] : undefined;
  if (typeof value !== "object" || value === null || !("answers" in value)) return undefined;
  return selectedOption(value.answers);
}

const deviceLabel = ({ client }: AuthClientSession) =>
  [client.label ?? client.browser ?? client.os ?? "已配对设备", client.os, client.browser]
    .filter((part, index, values) => part && values.indexOf(part) === index)
    .join(" · ");

const localThreadCaller = Effect.fn("ThreadFileSave.localThreadCaller")(function* () {
  const caller = yield* readCaller();
  const { thread } = yield* requireThreadScope(caller.scope, "会话文件保存");
  yield* assertLiveCaller(caller);
  if (thread.subagent || callerLinkOrigin(caller) !== undefined) {
    return yield* invalid("请在原会话中保存文件。");
  }
  return { thread, threads: caller.threads };
});

export const layer = McpToolAccess.toLayer(ThreadFileSaveToolkit, {
  t3_thread_file_save: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { thread, threads } = yield* localThreadCaller();
      const { threadId } = thread;
      const records = yield* threads
        .getThreadRecords(threadId, ["runs"], {
          runStatuses: ["starting", "running", "waiting"],
        })
        .pipe(Effect.mapError(unavailable));
      const run = records.runs
        .filter(
          (item) => item.providerInstanceId === thread.providerInstanceId && isActiveRun(item),
        )
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (!run) return yield* invalid("请从正在处理保存请求的会话发起。");

      const userMessage = (yield* threads
        .getMessagesById(threadId, [run.userMessageId])
        .pipe(Effect.mapError(unavailable))).get(run.userMessageId);
      if (
        userMessage?.role !== "user" ||
        userMessage.createdBy !== "user" ||
        !userMessage.clientOrigin
      ) {
        return yield* invalid("请从已连接的客户端发出保存请求。");
      }
      if (!hasExplicitThreadFileSaveIntent(userMessage.text)) {
        return yield* invalid("请在当前会话明确说明要保存文件，或使用附件旁的保存操作。");
      }
      const { clientAlias, surface } = userMessage.clientOrigin;
      const clients = (yield* (yield* EnvironmentAuth)
        .listSessions()
        .pipe(Effect.mapError(unavailable))).filter(
        (session) =>
          session.scopes.includes(AuthOrchestrationReadScope) &&
          session.client.deviceType !== "bot",
      );
      const sessions = yield* SessionStore;
      const digest = yield* Digest.Digest;
      const originAlias = (client: AuthClientSession) =>
        sessions.proofKeyThumbprintOf(client.sessionId).pipe(
          Effect.mapError(unavailable),
          Effect.flatMap((proof) =>
            digest.digest(
              Digest.sha256,
              new TextEncoder().encode(
                Option.isSome(proof)
                  ? `t3-message-origin:device:${proof.value}`
                  : `t3-message-origin:session:${client.sessionId}`,
              ),
            ),
          ),
          Effect.map((hash) => Buffer.from(hash).toString("base64url")),
        );
      const aliases = yield* Effect.forEach(
        clients,
        (client) => originAlias(client).pipe(Effect.map((alias) => ({ client, alias }))),
        { concurrency: 4 },
      );
      const requester = aliases.find(
        ({ client, alias }) =>
          alias === clientAlias && client.scopes.includes(AuthOrchestrationOperateScope),
      )?.client;
      if (!requester) return yield* invalid("发出保存请求的客户端授权已变化，请重新连接后再试。");
      const selectable = [
        ...new Map(aliases.toReversed().map((entry) => [entry.alias, entry.client])).values(),
      ];
      const exactClients = (name: string) =>
        selectable.filter((client) =>
          [deviceLabel(client), client.client.label].some(
            (candidate) => candidate?.normalize("NFKC").toLocaleLowerCase() === name,
          ),
        );
      const destination = threadFileDestination(userMessage.text);
      const requestedClients = destination.kind === "named" ? exactClients(destination.label) : [];
      const chosenClients =
        input.target === undefined
          ? []
          : exactClients(input.target.normalize("NFKC").toLocaleLowerCase());
      const namedRecipient = chosenClients.length === 1 ? chosenClients[0] : undefined;
      const currentRecipient =
        destination.kind === "current" &&
        (surface === "mobile" || surface === "desktop") &&
        (destination.device === "any" || destination.device === surface)
          ? requester
          : undefined;
      let choseNamedDevice = false;
      if (namedRecipient && requestedClients.length !== 1 && currentRecipient === undefined) {
        const choices = yield* threads
          .getThreadRecords(threadId, ["turnItems", "runtimeRequests"], {
            turnItemRunIds: [run.id],
            turnItemTypes: ["user_input_request"],
            runtimeRequestStatuses: ["resolved"],
          })
          .pipe(Effect.mapError(unavailable));
        const displayedName = deviceLabel(namedRecipient).normalize("NFKC").toLocaleLowerCase();
        choseNamedDevice = choices.turnItems.some((item) => {
          if (item.type !== "user_input_request") return false;
          const question = item.questions.find((candidate) => candidate.id === deviceChoiceId);
          const option = question?.options.find(
            (candidate) => candidate.label.normalize("NFKC").toLocaleLowerCase() === displayedName,
          );
          if (!option) return false;
          const answer = choices.runtimeRequests.find(
            (request) => request.id === item.requestId && request.kind === "user_input",
          )?.answers?.[deviceChoiceId];
          const selected = selectedOption(answer);
          return (
            selected === option.label || (option.value !== undefined && selected === option.value)
          );
        });
      }
      const recipient =
        requestedClients.length === 1
          ? requestedClients[0]
          : (currentRecipient ?? (choseNamedDevice ? namedRecipient : undefined));
      if (!recipient) {
        return {
          status: "choose_target" as const,
          reason:
            destination.kind === "current" && surface === "web"
              ? "请从会话使用浏览器下载，或选择接收文件的配对设备。"
              : "无法唯一确定接收设备，请使用已配对设备的完整名称。",
          devices: selectable.map((client) => ({
            label: deviceLabel(client),
            online: client.connected,
          })),
        };
      }

      const { source } = input;
      const config = yield* ServerConfig;
      let file: {
        readonly sourcePath: string;
        readonly name: string;
        readonly expectedSourceSha256?: string;
        readonly sourceFile?: OpenMediaFile;
      };
      if (source._tag === "delivery" || source._tag === "workspaceOutput") {
        file = yield* resolveWorkspaceOutput(source, records.thread, run, userMessage, threads);
      } else if (source._tag === "attachment") {
        const message = (yield* threads
          .getMessagesById(threadId, [source.messageId])
          .pipe(Effect.mapError(unavailable))).get(source.messageId);
        const attachment = message?.attachments.find((item) => item.id === source.attachmentId);
        const sourcePath = attachment
          ? resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment,
            })
          : null;
        if (!attachment || !sourcePath)
          return yield* invalid("该附件不属于本会话或原文件已不可用。");
        file = { sourcePath, name: attachment.name };
      } else {
        const task = yield* Effect.try({
          try: () => getCompanionStore(config.stateDir).result(threadId, source.taskId),
          catch: () => invalid("该设备结果不属于本会话或已不可用。"),
        });
        if (source._tag === "companionFile") {
          if (task.action !== "send-file" || task.status !== "done" || !task.transferredFile) {
            return yield* invalid("设备尚未完成发送，或原文件已不可用。");
          }
          const { path, name, sha256 } = task.transferredFile;
          file = { sourcePath: path, name, expectedSourceSha256: sha256 };
        } else {
          if (task.action !== "screenshot" || task.status !== "done" || !task.imagePath) {
            return yield* invalid("原截图还没有完成或已不可用。");
          }
          file = { sourcePath: task.imagePath, name: `截图-${task.id}.png` };
        }
      }
      const recipientAlias = yield* originAlias(recipient);
      const idHash = yield* digest.digestHex(
        Digest.sha256,
        new TextEncoder().encode(
          [
            threadId,
            run.userMessageId,
            source._tag === "delivery" || source._tag === "workspaceOutput"
              ? "workspace"
              : source._tag,
            ...(source._tag === "attachment"
              ? [source.messageId, source.attachmentId]
              : source._tag === "delivery" || source._tag === "workspaceOutput"
                ? [file.sourcePath]
                : [source.taskId]),
            recipientAlias,
          ]
            .map((field) => `${field.length}:${field}`)
            .join(""),
        ),
      );
      const id = `${idHash.slice(0, 8)}-${idHash.slice(8, 12)}-${idHash.slice(12, 16)}-${idHash.slice(16, 20)}-${idHash.slice(20, 32)}`;
      return yield* stageThreadFileHandoff({
        ...file,
        threadId,
        id,
        requester: requester.sessionId,
        recipient: recipient.sessionId,
        autoReceive: true,
      }).pipe(Effect.mapError((error) => invalid(error.message)));
    }).pipe(Effect.scoped),
  ),
  t3_thread_file_save_status: McpToolAccess.readsAsCaller(({ id, waitMs = 0 }) =>
    Effect.gen(function* () {
      const { thread } = yield* localThreadCaller();
      const read = readThreadFileHandoffStatus(thread.threadId, id).pipe(
        Effect.mapError((error) => invalid(error.message)),
      );
      const deadline = (yield* Clock.currentTimeMillis) + waitMs;
      let receipt = yield* read;
      while (receipt.status === "awaiting_save") {
        const remaining = deadline - (yield* Clock.currentTimeMillis);
        if (remaining <= 0) break;
        yield* Effect.sleep(Math.min(remaining, 250));
        receipt = yield* read;
      }
      return receipt;
    }),
  ),
});
