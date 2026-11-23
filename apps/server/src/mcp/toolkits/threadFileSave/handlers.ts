import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  OrchestratorMcpFailure,
  type AuthClientSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type { OpenMediaFile } from "../../../assets/MediaFile.ts";
import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import { EnvironmentAuth } from "../../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../../auth/SessionStore.ts";
import { archivedCapturePath, captureArchiveDirectory } from "../../../companion/captureArchive.ts";
import { getCompanionStore } from "../../../companion/store.ts";
import { ServerConfig } from "../../../config.ts";
import {
  manageThreadFileHandoff,
  readThreadFileHandoffStatus,
  stageThreadFileHandoff,
  stageThreadUrlDownload,
} from "../../../fileExchange/FileHandoff.ts";
import { isActiveRun } from "../../../orchestration-v2/ThreadManagementService.ts";
import { requireThreadScope } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { callerLinkOrigin } from "../../linkOrigin.ts";
import { assertLiveCaller, readCaller, unavailable } from "../../threadAccess.ts";
import {
  hasExplicitThreadFileSaveIntent,
  threadFileApkInstallRequest,
  threadFileDestination,
  threadFileManagementIntent,
  threadFileRedirectDestination,
  threadFileUrlRequest,
} from "./intent.ts";
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

const waitForReceipt = Effect.fn("ThreadFileSave.waitForReceipt")(function* (
  threadId: ThreadId,
  id: string,
  waitMs: number,
) {
  const read = readThreadFileHandoffStatus(threadId, id).pipe(
    Effect.mapError((error) => invalid(error.message)),
  );
  const deadline = (yield* Clock.currentTimeMillis) + waitMs;
  let receipt = yield* read;
  while (receipt.status === "awaiting_save" && !receipt.urlFailure) {
    const remaining = deadline - (yield* Clock.currentTimeMillis);
    if (remaining <= 0) break;
    yield* Effect.sleep(Math.min(remaining, 250));
    receipt = yield* read;
  }
  return receipt;
});

// 移动端前台每 5 秒轮询收件箱，留出一个轮询周期和短时写盘余量。
const ONLINE_WORKSPACE_RECEIPT_WAIT_MS = 6_000;
const saveThreadFile = Effect.fn("ThreadFileSave.saveThreadFile")(function* (
  input: typeof ThreadFileSaveToolkit.tools.t3_thread_file_save.parametersSchema.Type,
  waitForOnlineReceipt = false,
) {
  const { action, source, id: requestedId, target } = input;
  if (
    (action === undefined && (!source || requestedId !== undefined)) ||
    (action !== undefined && source !== undefined) ||
    (action === "cancel" && target !== undefined)
  ) {
    return yield* invalid("请指定发送来源或既有传输操作。");
  }
  const { thread, threads } = yield* localThreadCaller();
  const { threadId } = thread;
  const records = yield* threads
    .getThreadRecords(threadId, ["runs"], {
      runStatuses: ["starting", "running", "waiting"],
    })
    .pipe(Effect.mapError(unavailable));
  const run = records.runs
    .filter((item) => item.providerInstanceId === thread.providerInstanceId && isActiveRun(item))
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
  const apkInstallRequest =
    action === undefined && source?._tag !== "url"
      ? threadFileApkInstallRequest(userMessage.text)
      : undefined;
  const requestText =
    source?._tag === "url"
      ? threadFileUrlRequest(userMessage.text, source.url)
      : (apkInstallRequest ?? userMessage.text);
  if (requestText === undefined)
    return yield* invalid("请在原会话明确要求下载，并提供该文件的完整网址。");
  if (action !== undefined) {
    if (threadFileManagementIntent(userMessage.text) !== action) {
      return yield* invalid("请在原会话明确要求取消或改发这次文件传输。");
    }
  } else if (
    !hasExplicitThreadFileSaveIntent(requestText) ||
    threadFileManagementIntent(userMessage.text)
  ) {
    return yield* invalid("请在当前会话明确说明要保存文件，或使用附件旁的保存操作。");
  }
  const { clientAlias, surface } = userMessage.clientOrigin;
  const clients = (yield* (yield* EnvironmentAuth)
    .listSessions()
    .pipe(Effect.mapError(unavailable))).filter(
    (session) =>
      session.scopes.includes(AuthOrchestrationReadScope) && session.client.deviceType !== "bot",
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
    ...new Map(aliases.toReversed().map((entry) => [entry.alias, entry])).values(),
  ];
  const deliveryRequest = {
    threadId,
    requestText: userMessage.text,
    requester: requester.sessionId,
    requesterAlias: clientAlias,
    requestId: userMessage.id,
    ordinal: run.ordinal,
    ...(requestedId === undefined ? {} : { requestedId }),
  };
  if (action === "cancel") {
    return yield* manageThreadFileHandoff(deliveryRequest).pipe(
      Effect.mapError((error) => invalid(error.message)),
    );
  }
  const normalizedLabel = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
  const choicesByDevice = selectable.map(({ client, alias }) => {
    const label = deviceLabel(client);
    const duplicates = selectable.filter(
      (entry) => normalizedLabel(deviceLabel(entry.client)) === normalizedLabel(label),
    );
    return {
      client,
      label: duplicates.length > 1 ? `${label} · ${alias.slice(0, 12)}` : label,
    };
  });
  const exactClients = (name: string) =>
    choicesByDevice.filter(({ client, label }) =>
      [label, deviceLabel(client), client.client.label].some(
        (candidate) => candidate !== undefined && normalizedLabel(candidate) === name,
      ),
    );
  const destination =
    action === "redirect"
      ? threadFileRedirectDestination(userMessage.text)
      : threadFileDestination(requestText);
  const requestedClients = destination.kind === "named" ? exactClients(destination.label) : [];
  const chosenClients =
    target === undefined
      ? []
      : choicesByDevice.filter(({ label }) => normalizedLabel(label) === normalizedLabel(target));
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
    const displayedName = normalizedLabel(namedRecipient.label);
    choseNamedDevice = choices.turnItems.some((item) => {
      if (item.type !== "user_input_request") return false;
      const question = item.questions.find((candidate) => candidate.id === deviceChoiceId);
      if (!question || question.multiSelect) return false;
      const answer = choices.runtimeRequests.find(
        (request) => request.id === item.requestId && request.kind === "user_input",
      )?.answers?.[deviceChoiceId];
      const selected = selectedOption(answer);
      const matched = question.options.filter(
        (option) => (option.value ?? option.label) === selected,
      );
      return matched.length === 1 && normalizedLabel(matched[0]!.label) === displayedName;
    });
  }
  const recipient =
    requestedClients.length === 1
      ? requestedClients[0]?.client
      : (currentRecipient ?? (choseNamedDevice ? namedRecipient?.client : undefined));
  if (!recipient) {
    return {
      status: "choose_target" as const,
      reason:
        destination.kind === "current" && surface === "web"
          ? "请从会话使用浏览器下载，或选择接收文件的配对设备。"
          : "无法唯一确定接收设备，请使用已配对设备的完整名称。",
      devices: choicesByDevice.map(({ client, label }) => ({
        label,
        online: client.connected,
      })),
    };
  }

  if (action === "redirect") {
    return yield* manageThreadFileHandoff({
      ...deliveryRequest,
      recipient: recipient.sessionId,
    }).pipe(Effect.mapError((error) => invalid(error.message)));
  }

  if (!source) return yield* invalid("请指定要发送的文件。");
  if (
    apkInstallRequest &&
    !(recipient.client.browser === undefined && recipient.client.os?.toLowerCase() === "android")
  ) {
    return yield* invalid("此设备无法确认 APK 安装，请选择已配对的 Android 客户端。");
  }
  if (source._tag === "url") {
    const recipientAlias = yield* originAlias(recipient);
    const hash = yield* digest.digestHex(
      Digest.sha256,
      new TextEncoder().encode(
        [threadId, run.userMessageId, "url", source.url, recipientAlias]
          .map((field) => `${field.length}:${field}`)
          .join(""),
      ),
    );
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    return yield* stageThreadUrlDownload({
      threadId,
      id,
      requester: requester.sessionId,
      requesterAlias: clientAlias,
      sourceOrdinal: run.ordinal,
      recipient: recipient.sessionId,
      sourceUrl: source.url,
    }).pipe(Effect.mapError((error) => invalid(error.message)));
  }
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
    if (!attachment || !sourcePath) return yield* invalid("该附件不属于本会话或原文件已不可用。");
    file = { sourcePath, name: attachment.name };
  } else if (source._tag === "companionFile") {
    const task = yield* Effect.try({
      try: () => getCompanionStore(config.stateDir).result(threadId, source.taskId),
      catch: () => invalid("该设备结果不属于本会话或已不可用。"),
    });
    if (task.action !== "send-file" || task.status !== "done" || !task.transferredFile) {
      return yield* invalid("设备尚未完成发送，或原文件已不可用。");
    }
    const { path, name, sha256 } = task.transferredFile;
    file = { sourcePath: path, name, expectedSourceSha256: sha256 };
  } else {
    const fs = yield* FileSystem.FileSystem;
    const archive = archivedCapturePath(
      captureArchiveDirectory(config.stateDir, threadId),
      source.taskId,
      "png",
    );
    const archived =
      archive !== null && (yield* fs.exists(archive).pipe(Effect.orElseSucceed(() => false)));
    const sourcePath = archived
      ? archive
      : yield* Effect.try({
          try: () => getCompanionStore(config.stateDir).result(threadId, source.taskId).imagePath,
          catch: () => invalid("该设备结果不属于本会话或已不可用。"),
        });
    if (!sourcePath) return yield* invalid("原截图还没有完成或已不可用。");
    file = { sourcePath, name: `截图-${source.taskId}.png` };
  }
  if (apkInstallRequest && !file.name.toLowerCase().endsWith(".apk")) {
    return yield* invalid("请指定要发送并安装的 APK 文件。");
  }
  const recipientAlias = yield* originAlias(recipient);
  const idHash = yield* digest.digestHex(
    Digest.sha256,
    new TextEncoder().encode(
      [
        threadId,
        run.userMessageId,
        source._tag === "delivery" || source._tag === "workspaceOutput" ? "workspace" : source._tag,
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
  const staged = yield* stageThreadFileHandoff({
    ...file,
    threadId,
    id,
    requester: requester.sessionId,
    requesterAlias: clientAlias,
    sourceOrdinal: run.ordinal,
    recipient: recipient.sessionId,
    autoReceive: true,
    ...(apkInstallRequest ? { installRequested: true as const } : {}),
  }).pipe(Effect.mapError((error) => invalid(error.message)));
  if (!waitForOnlineReceipt || staged.status !== "awaiting_save" || !recipient.connected) {
    return staged;
  }
  return yield* waitForReceipt(threadId, staged.id, ONLINE_WORKSPACE_RECEIPT_WAIT_MS).pipe(
    Effect.orElseSucceed(() => staged),
  );
}, Effect.scoped);

export const layer = McpToolAccess.toLayer(ThreadFileSaveToolkit, {
  t3_thread_save_workspace_file: McpToolAccess.actsAsCaller(({ path, target }) =>
    saveThreadFile(
      {
        source: { _tag: "workspaceOutput", path },
        ...(target === undefined ? {} : { target }),
      },
      true,
    ),
  ),
  t3_thread_file_save: McpToolAccess.actsAsCaller((input) => saveThreadFile(input)),
  t3_thread_file_save_status: McpToolAccess.readsAsCaller(({ id, waitMs = 0 }) =>
    Effect.gen(function* () {
      const { thread } = yield* localThreadCaller();
      return yield* waitForReceipt(thread.threadId, id, waitMs);
    }),
  ),
});
