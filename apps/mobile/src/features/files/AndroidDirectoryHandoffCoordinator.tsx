import { sendHandoffFile, unwrapFileHandoff } from "@t3tools/client-runtime/state/fileHandoff";
import {
  AuthOrchestrationOperateScope,
  type AndroidDirectoryFileJob,
  type AuthSessionId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { fetch } from "expo/fetch";
import { File } from "expo-file-system";
import { useEffect, useEffectEvent, useRef } from "react";

import { isAppActive, useAppActive } from "../../lib/appState";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { androidDirectory, type AndroidDirectoryModule } from "./androidDirectory";
import { androidDirectoryHandoff, androidDirectoryQuiet } from "./android-directory-handoff";
import { localScreenCapture } from "./localScreenCapture";

// 大文件的暂存、校验和上传可能持续多个收件箱轮询周期。
const DIRECTORY_HEARTBEAT_INTERVAL_MS = 20_000;

function EnvironmentDirectoryHandoff({
  environmentId,
  native,
}: {
  readonly environmentId: EnvironmentId;
  readonly native: AndroidDirectoryModule;
}) {
  const active = useAppActive();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const command = useAtomCommand(androidDirectoryHandoff.receive, androidDirectoryQuiet);
  const start = useAtomCommand(androidDirectoryHandoff.start, androidDirectoryQuiet);
  const running = useRef<AbortController | null>(null);
  const announced = useRef<string | null>(null);

  async function send(
    job: AndroidDirectoryFileJob,
    httpBaseUrl: string,
    sessionId: AuthSessionId,
    revision: string,
    controller: AbortController,
  ) {
    let nextHeartbeat = Date.now() + DIRECTORY_HEARTBEAT_INTERVAL_MS;
    const report = (reason: "revoked" | "missing" | "ambiguous" | "too-large" | "failed") =>
      command({
        environmentId,
        input: { _tag: "androidPullFailed", threadId: job.threadId, id: job.id, revision, reason },
      });

    let result;
    try {
      result = await native.readFile(environmentId, sessionId, revision, job.name, job.maxBytes);
    } catch {
      if (!controller.signal.aborted && isAppActive()) await report("failed");
      return;
    }
    if (result.status !== "ready") {
      if (!controller.signal.aborted && isAppActive()) await report(result.status);
      return;
    }
    const file = new File(result.uri);
    let revoked = false;
    async function validateGrant() {
      controller.signal.throwIfAborted();
      if (!isAppActive() || (localScreenCapture && !(await localScreenCapture.isUnlocked()))) {
        throw new Error("手机已锁定或离开前台。");
      }
      if ((await native.getGrant(environmentId, sessionId))?.revision !== revision) {
        revoked = true;
        throw new Error("目录读取授权已撤销。");
      }
      if (Date.now() >= nextHeartbeat) {
        const reply = unwrapFileHandoff(
          await command({
            environmentId,
            input: { _tag: "androidPullInbox", revision, sessionId },
          }),
        );
        if (reply._tag !== "androidPullInbox" || reply.sessionId !== sessionId) {
          revoked = true;
          throw new Error("配对会话已变化。");
        }
        nextHeartbeat = Date.now() + DIRECTORY_HEARTBEAT_INTERVAL_MS;
      }
      controller.signal.throwIfAborted();
    }
    try {
      await validateGrant();
      const handle = file.open();
      try {
        const sizeBytes = handle.size;
        if (sizeBytes === null) {
          await report("failed");
          return;
        }
        await sendHandoffFile({
          environmentId,
          httpBaseUrl,
          start: async (target) => {
            await validateGrant();
            return start(target);
          },
          input: {
            threadId: job.threadId,
            id: job.id,
            recipient: job.recipient,
            name: job.name,
            sizeBytes,
            directoryRevision: revision,
          },
          slice: async (offset, length) => {
            await validateGrant();
            handle.offset = offset;
            return length === 0 ? new Uint8Array() : handle.readBytes(length);
          },
          post: async (url, body, signal) => {
            await validateGrant();
            return fetch(url, {
              method: "POST",
              body,
              signal,
              headers: { "Content-Type": "application/octet-stream" },
            });
          },
          signal: controller.signal,
          onProgress: () => {},
        });
      } finally {
        handle.close();
      }
    } catch {
      if (revoked && !controller.signal.aborted) await report("revoked");
      // 网络中断时保留服务端已校验的分块，重连后按同一请求继续。
    } finally {
      try {
        if (file.exists) file.delete();
      } catch {
        // 原生模块定期清理过期的私有暂存。
      }
    }
  }

  const fetchJobs = useEffectEvent(async (url: string, controller: AbortController) => {
    const available = () => isAppActive() && !controller.signal.aborted;
    const grant = await native.getGrant(environmentId, null);
    const revision = grant?.revision;
    if (!available() || (!revision && !announced.current)) return;
    const reply = unwrapFileHandoff(
      await command({
        environmentId,
        input: grant
          ? { _tag: "androidPullInbox", revision: grant.revision, sessionId: grant.sessionId }
          : { _tag: "androidPullInbox", revoke: true },
      }),
    );
    if (reply._tag !== "androidPullInbox" || !available()) return;
    if (!revision) {
      announced.current = null;
      return;
    }
    if ((await native.getGrant(environmentId, reply.sessionId))?.revision !== revision) {
      await command({ environmentId, input: { _tag: "androidPullInbox", revoke: true } });
      announced.current = null;
      return;
    }
    announced.current = revision;
    for (const job of reply.jobs) {
      if (!available() || (localScreenCapture && !(await localScreenCapture.isUnlocked()))) return;
      await send(job, url, reply.sessionId, revision, controller);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 前台配对连接负责目录授权心跳和分块上传。
  useEffect(() => {
    if (!active || !canOperate || !httpBaseUrl) return;
    const poll = () => {
      if (running.current) return;
      const controller = new AbortController();
      running.current = controller;
      void fetchJobs(httpBaseUrl, controller)
        .catch(() => {})
        .finally(() => {
          if (running.current === controller) running.current = null;
        });
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => {
      clearInterval(timer);
      running.current?.abort();
    };
  }, [active, canOperate, httpBaseUrl]);

  return null;
}

export function AndroidDirectoryHandoffCoordinator() {
  const environments = useWorkspaceEnvironments();
  if (!androidDirectory) return null;
  const native = androidDirectory;
  return environments.map(({ environmentId, isEnabled, connectionState }) =>
    isEnabled && connectionState === "connected" ? (
      <EnvironmentDirectoryHandoff
        key={environmentId}
        environmentId={environmentId}
        native={native}
      />
    ) : null,
  );
}
