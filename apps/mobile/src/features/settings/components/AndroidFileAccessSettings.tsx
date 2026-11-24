import { unwrapFileHandoff } from "@t3tools/client-runtime/state/fileHandoff";
import { AuthOrchestrationOperateScope, type AuthSessionId, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { useAppActive } from "../../../lib/appState";
import { useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { androidDirectory, type AndroidDirectoryGrant } from "../../files/androidDirectory";
import {
  androidDirectoryHandoff,
  androidDirectoryQuiet,
} from "../../files/android-directory-handoff";
import { SettingsSection } from "./SettingsSection";

export function AndroidFileAccessSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const active = useAppActive();
  const permitted = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const request = useAtomCommand(androidDirectoryHandoff.receive, androidDirectoryQuiet);
  const [grant, setGrant] = useState<AndroidDirectoryGrant | null>(null);
  const [pairing, setPairing] = useState<AuthSessionId | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "choosing" | "revoking">("loading");
  const [error, setError] = useState<string | null>(null);
  const native = androidDirectory;
  const readPairing = useEffectEvent(async () => {
    const reply = unwrapFileHandoff(
      await request({ environmentId, input: { _tag: "androidPullInbox" } }),
    );
    return reply._tag === "androidPullInbox" ? reply.sessionId : null;
  });
  const stale = grant !== null && pairing !== null && grant.sessionId !== pairing;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 返回前台时核对 Android 系统是否撤回了持久授权。
  useEffect(() => {
    if (!native || !active) return;
    let mounted = true;
    void native.getGrant(environmentId, null).then(
      (current) => {
        if (!mounted) return;
        setGrant(current);
        setPairing(null);
        setStatus((previous) => (previous === "loading" ? "ready" : previous));
        if (permitted && current) {
          void readPairing().then(
            (session) => {
              if (mounted) setPairing(session);
            },
            () => {},
          );
        }
      },
      () => {
        if (!mounted) return;
        setError("无法读取目录授权。");
        setStatus("ready");
      },
    );
    return () => {
      mounted = false;
    };
  }, [active, environmentId, permitted]);

  if (!native) return null;

  async function choose() {
    if (!native || !permitted || status !== "ready") return;
    setStatus("choosing");
    setError(null);
    try {
      const reply = unwrapFileHandoff(
        await request({ environmentId, input: { _tag: "androidPullInbox" } }),
      );
      if (reply._tag !== "androidPullInbox") throw new Error("无法读取此环境的配对状态。");
      const result = await native.chooseGrant(
        environmentId,
        reply.sessionId,
        grant?.revision ?? null,
      );
      if (result) {
        setGrant(result);
        setPairing(reply.sessionId);
        void request({
          environmentId,
          input: { _tag: "androidPullInbox", revision: result.revision, sessionId: result.sessionId },
        });
      }
    } catch {
      setError("无法授权读取目录，请确认环境在线后重试。");
    } finally {
      setStatus("ready");
    }
  }

  async function revoke() {
    if (!native || status !== "ready") return;
    setStatus("revoking");
    setError(null);
    try {
      await native.revokeGrant(environmentId);
      setGrant(null);
      if (permitted)
        void request({ environmentId, input: { _tag: "androidPullInbox", revoke: true } });
    } catch {
      setError("无法撤销目录授权，请重试。");
    } finally {
      setStatus("ready");
    }
  }

  return (
    <SettingsSection
      title="会话按文件名取件"
      footer="此配对环境的会话可以按完整文件名读取此目录中的文件。授权范围不含子目录。"
    >
      <ListActionRow
        icon="folder"
        label={grant && !stale ? "更换取件目录" : "选择取件目录"}
        description={
          stale ? "配对已变化，请重新授权" : grant?.name ?? (permitted ? "尚未授权" : "连接配对环境后可授权")
        }
        disabled={!permitted || status !== "ready"}
        loading={status === "loading" || status === "choosing"}
        onPress={() => void choose()}
      />
      {grant ? (
        <ListActionRow
          icon="xmark"
          label="撤销目录授权"
          disabled={status !== "ready"}
          loading={status === "revoking"}
          onPress={() => void revoke()}
        />
      ) : null}
      {error ? <ListRowLayout label={error} /> : null}
    </SettingsSection>
  );
}
