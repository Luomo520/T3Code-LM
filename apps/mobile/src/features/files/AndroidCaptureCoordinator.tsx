import {
  type AndroidCaptureInput,
  AuthOrchestrationOperateScope,
  COMPANION_MAX_IMAGE_BYTES,
  type EnvironmentId,
} from "@t3tools/contracts";
import { File } from "expo-file-system";
import { useCallback, useEffect, useEffectEvent, useRef } from "react";
import { Alert, ToastAndroid } from "react-native";

import { isAppActive, useAppActive } from "../../lib/appState";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import {
  canNotifyAndroidCaptureRequests,
  noteAndroidCaptureBackgroundReady,
} from "../agent-awareness/androidNotifications";
import {
  androidCapturePhoneName,
  captureCommand,
  type AndroidCaptureJobData,
} from "./androidCaptureClient";
import { readAndroidCapturePolicy } from "./androidCapturePolicy";
import { localScreenCapture, type CaptureSharingChoice } from "./localScreenCapture";

type Job = AndroidCaptureJobData;
type NativeCapture = NonNullable<typeof localScreenCapture>;
type ScopedShare = {
  readonly threadId: Job["threadId"];
  readonly routeKey: string;
  readonly action: Job["action"];
};
type ShareChoice = ScopedShare & { readonly choice: CaptureSharingChoice };

function currentThreadRoute(environmentId: EnvironmentId, threadId: Job["threadId"]) {
  if (!rootNavigationRef.isReady()) return null;
  const route = rootNavigationRef.getCurrentRoute();
  if (route?.name !== "Thread") return null;
  const params = route.params as { environmentId?: string; threadId?: string } | undefined;
  return params?.environmentId === environmentId && params.threadId === threadId ? route.key : null;
}

function captureKind(action: Job["action"]) {
  return action === "screenshot" ? "screenshot" : "recording";
}

// 应用同一时间只有一个原生对话框。跨环境请求保留排队，等待本机继续处理。
let captureOwner: string | null = null;

function EnvironmentCaptureCoordinator({
  active,
  environmentId,
  environmentLabel,
  native,
}: {
  readonly active: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly native: NativeCapture;
}) {
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const command = useAtomCommand(captureCommand, { reportFailure: false, reportDefect: false });
  const presented = useRef<string | null>(null);
  const offered = useRef<Job | null>(null);
  const available = useRef(false);
  const current = useRef<string | null>(null);
  const backendApproved = useRef(false);
  const lockedRequest = useRef<string | null>(null);
  const busy = useRef(false);
  const shared = useRef<ScopedShare | null>(null);
  const endShare = useCallback(() => {
    shared.current = null;
    void native.endSharing?.(environmentId).catch(() => {});
  }, [environmentId, native]);
  const request = (input: typeof AndroidCaptureInput.Type) => command({ environmentId, input });

  const recordingReceipt = useRef<string | null>(null);
  useEffect(() => {
    const subscription = native.addListener?.("onRecordingStarted", ({ requestId }) => {
      if (recordingReceipt.current !== requestId || current.current !== requestId) return;
      void command({
        environmentId,
        input: { _tag: "progress", id: requestId, stage: "recording" },
      }).catch(() => {});
    });
    return () => subscription?.remove();
  }, [command, environmentId, native]);

  async function finish(
    input: Extract<typeof AndroidCaptureInput.Type, { _tag: "reject" | "complete" }>,
    action?: Job["action"],
  ) {
    const response = await request(input);
    if (response._tag === "Success") return;
    // 传输结果已提交但未收到响应时，服务端接受相同结果的重试。
    if (input._tag === "complete" && action) {
      if (!(await native.isUnlocked())) {
        await request({ _tag: "reject", id: input.id, reason: "locked" });
        return;
      }
      if (readAndroidCapturePolicy(environmentId, action) === "deny") {
        await request({ _tag: "reject", id: input.id, reason: "denied" });
        return;
      }
    }
    await request(input);
  }

  async function capture(job: Job, selectedShare?: ShareChoice) {
    let selection = selectedShare;
    if (!available.current || current.current !== null || captureOwner !== job.id) return;
    current.current = job.id;
    const stillCurrent = () => current.current === job.id;
    let file: File | undefined;
    try {
      if (!(await native.isUnlocked()) || !isAppActive()) {
        presented.current = null;
        return;
      }
      if (!stillCurrent()) return;
      if (readAndroidCapturePolicy(environmentId, job.action) === "deny") {
        await finish({ _tag: "reject", id: job.id, reason: "denied" });
        return;
      }
      const approved = await request({ _tag: "approve", id: job.id });
      if (approved._tag !== "Success" || approved.value._tag !== "active") {
        ToastAndroid.show("屏幕捕获请求已失效，请在原会话重试。", ToastAndroid.SHORT);
        return;
      }
      if (!stillCurrent() || !isAppActive()) {
        await finish({ _tag: "reject", id: job.id, reason: "canceled" });
        return;
      }
      if (readAndroidCapturePolicy(environmentId, job.action) === "deny") {
        await finish({ _tag: "reject", id: job.id, reason: "denied" });
        return;
      }
      if (
        selection &&
        (approved.value.job.threadId !== selection.threadId ||
          approved.value.job.id !== job.id ||
          approved.value.job.action !== selection.action ||
          approved.value.job.durationSeconds !== job.durationSeconds ||
          currentThreadRoute(environmentId, selection.threadId) !== selection.routeKey)
      ) {
        endShare();
        await finish({ _tag: "reject", id: job.id, reason: "canceled" });
        return;
      }
      backendApproved.current = true;
      recordingReceipt.current = job.progressReceipts ? job.id : null;
      const kind = captureKind(job.action);
      const captureOnce = () =>
        native.captureEnvironmentRequest
          ? native.captureEnvironmentRequest(kind, job.id, job.durationSeconds, environmentId)
          : native.captureApprovedRequest?.(kind, job.id, job.durationSeconds);
      if (selection) shared.current = selection;
      let result =
        selection && native.captureScopedRequest
          ? await native.captureScopedRequest(
              kind,
              job.id,
              job.durationSeconds,
              environmentId,
              selection.threadId,
              selection.routeKey,
              selection.choice,
            )
          : await captureOnce();
      backendApproved.current = false;
      if (selection?.choice === "reuse" && result?.status === "sharing_unavailable") {
        const scope = selection;
        endShare();
        selection = undefined;
        const canContinue = () =>
          stillCurrent() &&
          isAppActive() &&
          currentThreadRoute(environmentId, scope.threadId) === scope.routeKey;
        if (!canContinue() || !(await native.isUnlocked())) {
          await finish({ _tag: "reject", id: job.id, reason: "canceled" });
          return;
        }
        // 投屏可能在领取请求与采集之间到期。同一任务可重新确认，只有机主点击才打开系统授权。
        const confirmed = await new Promise<boolean>((resolve) =>
          Alert.alert(
            job.action === "screenshot" ? "允许本次截图？" : "允许本次录屏？",
            "60 秒共享已结束或不可用。继续系统授权可处理这一次请求。",
            [
              { text: "拒绝", style: "cancel", onPress: () => resolve(false) },
              { text: "继续系统授权", onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          ),
        );
        if (!confirmed || !canContinue()) {
          await finish({ _tag: "reject", id: job.id, reason: confirmed ? "canceled" : "denied" });
          return;
        }
        if (
          !(await native.isUnlocked()) ||
          readAndroidCapturePolicy(environmentId, job.action) === "deny"
        ) {
          await finish({ _tag: "reject", id: job.id, reason: "revoked" });
          return;
        }
        const latest = await request({ _tag: "status", id: job.id });
        if (latest._tag !== "Success" || latest.value._tag !== "active" || !canContinue()) {
          await finish({ _tag: "reject", id: job.id, reason: "canceled" });
          return;
        }
        backendApproved.current = true;
        result = await captureOnce();
        backendApproved.current = false;
      }
      if (!result || result.status !== "done") {
        if (selection) endShare();
        await finish({
          _tag: "reject",
          id: job.id,
          reason:
            lockedRequest.current === job.id
              ? "locked"
              : result?.status === "sharing_unavailable"
                ? "revoked"
                : (result?.status ?? "failed"),
        });
        return;
      }
      file = new File(result.uri);
      if (!stillCurrent()) return;
      if (
        selection &&
        currentThreadRoute(environmentId, selection.threadId) !== selection.routeKey
      ) {
        endShare();
        await finish({ _tag: "reject", id: job.id, reason: "canceled" });
        return;
      }
      if (!(await native.isUnlocked())) {
        await finish({ _tag: "reject", id: job.id, reason: "locked" });
        return;
      }
      if (file.size > COMPANION_MAX_IMAGE_BYTES) {
        await finish({ _tag: "reject", id: job.id, reason: "failed" });
        return;
      }
      const media = await file.base64();
      if (!stillCurrent()) return;
      const unlocked = await native.isUnlocked();
      const shareStillVisible =
        selection && unlocked
          ? await native.canAutoReuseSharing?.(
              kind,
              environmentId,
              selection.threadId,
              selection.routeKey,
              0,
            )
          : false;
      if (!stillCurrent()) return;
      if (
        selection &&
        (!shareStillVisible ||
          !isAppActive() ||
          shared.current?.routeKey !== selection.routeKey ||
          currentThreadRoute(environmentId, selection.threadId) !== selection.routeKey)
      ) {
        endShare();
        await finish({ _tag: "reject", id: job.id, reason: "canceled" });
      } else if (readAndroidCapturePolicy(environmentId, job.action) === "deny") {
        await finish({ _tag: "reject", id: job.id, reason: "denied" });
      } else if (unlocked) await finish({ _tag: "complete", id: job.id, media }, job.action);
      else await finish({ _tag: "reject", id: job.id, reason: "locked" });
    } catch {
      if (selection) endShare();
      if (stillCurrent()) await finish({ _tag: "reject", id: job.id, reason: "failed" });
    } finally {
      if (file?.exists) {
        try {
          file.delete();
        } catch {
          // 私有缓存由屏幕捕获模块定期清理。
        }
      }
      if (stillCurrent()) {
        backendApproved.current = false;
        lockedRequest.current = null;
        current.current = null;
      }
      if (captureOwner === job.id) captureOwner = null;
    }
  }

  const poll = useEffectEvent(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const running = current.current;
      if (running !== null) {
        if (!(await native.isUnlocked())) {
          lockedRequest.current = running;
          if (shared.current) endShare();
          await native.cancelCapture(running);
          await finish({ _tag: "reject", id: running, reason: "locked" });
          return;
        }
        if (!backendApproved.current) return;
        const status = await request({ _tag: "status", id: running });
        if (
          current.current === running &&
          backendApproved.current &&
          (status._tag !== "Success" || status.value._tag === "inactive")
        ) {
          if (shared.current) endShare();
          await native.cancelCapture(running);
        }
        return;
      }
      if (!active || !isAppActive() || !available.current || !(await native.isUnlocked())) return;
      const canReceive =
        readAndroidCapturePolicy(environmentId, "screenshot") !== "deny" ||
        readAndroidCapturePolicy(environmentId, "record-screen") !== "deny";
      const response = await request({
        _tag: "listen",
        name: androidCapturePhoneName(),
        ...(!canReceive
          ? { delivery: "unavailable" }
          : canNotifyAndroidCaptureRequests()
            ? { delivery: "background-ready" }
            : {}),
      });
      if (response._tag !== "Success" || response.value._tag !== "pending") return;
      if (response.value.backgroundReady) noteAndroidCaptureBackgroundReady();
      if (!available.current || !isAppActive()) return;
      const job = response.value.job;
      const existing = offered.current;
      if (existing && existing.id !== job?.id) {
        offered.current = null;
        if (captureOwner === existing.id) captureOwner = null;
      }
      if (!job || presented.current === job.id || captureOwner) return;
      if (job.progressReceipts) {
        void request({ _tag: "progress", id: job.id, stage: "received" }).catch(() => {});
      }
      const policy = readAndroidCapturePolicy(environmentId, job.action);
      presented.current = job.id;
      if (policy === "deny") {
        await finish({ _tag: "reject", id: job.id, reason: "denied" });
        return;
      }
      captureOwner = job.id;
      offered.current = job;
      const routeKey =
        native.captureScopedRequest && native.canAutoReuseSharing
          ? currentThreadRoute(environmentId, job.threadId)
          : null;
      const scope = routeKey ? { threadId: job.threadId, routeKey, action: job.action } : null;
      const held = shared.current;
      const sharing =
        scope &&
        held?.routeKey === scope.routeKey &&
        held.threadId === scope.threadId &&
        held.action === scope.action &&
        (await native
          .canAutoReuseSharing?.(
            captureKind(job.action),
            environmentId,
            job.threadId,
            scope.routeKey,
            job.durationSeconds,
          )
          .catch(() => false));
      const offerHold =
        scope && !sharing && policy === "ask"
          ? await native.canKeepSharing?.().catch(() => false)
          : false;
      if (!available.current || !isAppActive() || offered.current?.id !== job.id) {
        offered.current = null;
        if (captureOwner === job.id) captureOwner = null;
        presented.current = null;
        return;
      }
      if (
        scope &&
        sharing &&
        currentThreadRoute(environmentId, scope.threadId) === scope.routeKey
      ) {
        offered.current = null;
        void capture(job, { ...scope, choice: "reuse" });
        return;
      }
      if (policy === "system" && native.captureEnvironmentRequest) {
        offered.current = null;
        void capture(job);
        return;
      }
      const isRecording = job.action === "record-screen";
      const decide = (approved: boolean, hold = false) => {
        if (offered.current?.id !== job.id) return;
        offered.current = null;
        if (!isAppActive()) {
          if (captureOwner === job.id) captureOwner = null;
          presented.current = null;
          return;
        }
        if (approved) {
          if (
            hold &&
            (!scope || currentThreadRoute(environmentId, job.threadId) !== scope.routeKey)
          ) {
            if (captureOwner === job.id) captureOwner = null;
            void finish({ _tag: "reject", id: job.id, reason: "canceled" });
            return;
          }
          void capture(job, hold && scope ? { ...scope, choice: "hold" } : undefined);
        } else {
          if (captureOwner === job.id) captureOwner = null;
          void finish({ _tag: "reject", id: job.id, reason: "denied" });
        }
      };
      // 使用独立的 Android 原生对话框承接这次明确授权。
      Alert.alert(
        isRecording ? "允许本次录屏？" : "允许本次截图？",
        (isRecording
          ? `「${environmentLabel}」的会话请求录屏，最长 ${job.durationSeconds} 秒。授权后，结果将发送回发起请求的会话。`
          : `「${environmentLabel}」的会话请求截图。授权后，截图将发送回发起请求的会话。`) +
          (offerHold
            ? ` 屏幕解锁且停留在原会话时，系统共享和停止通知可见期间，60 秒内会自动处理此会话的${isRecording ? "录屏" : "截图"}请求。可在通知栏结束共享。`
            : ""),
        [
          ...(offerHold
            ? [
                {
                  text: `自动${isRecording ? "录屏" : "截图"} 60 秒`,
                  onPress: () => decide(true, true),
                },
              ]
            : []),
          { text: "拒绝", style: "cancel", onPress: () => decide(false) },
          { text: "继续系统授权", onPress: () => decide(true) },
        ],
        { cancelable: true, onDismiss: () => decide(false) },
      );
    } catch {
      // 下次前台心跳检查连接期间的请求变化。
    } finally {
      busy.current = false;
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 前台读取配对会话请求，录制期间持续核对服务端授权状态。
  useEffect(() => {
    if (!canOperate) return;
    available.current = true;
    const timer = setInterval(() => void poll(), 4_000);
    const unsubscribe =
      native.endSharing &&
      rootNavigationRef.addListener("state", () => {
        const scope = shared.current;
        if (scope && currentThreadRoute(environmentId, scope.threadId) !== scope.routeKey) {
          endShare();
        }
      });
    return () => {
      clearInterval(timer);
      unsubscribe?.();
      if (shared.current) endShare();
      available.current = false;
      const job = current.current;
      if (captureOwner === offered.current?.id || captureOwner === job) captureOwner = null;
      offered.current = null;
      presented.current = null;
      backendApproved.current = false;
      current.current = null;
      if (job) void native.cancelCapture(job).catch(() => {});
    };
  }, [canOperate, endShare, environmentId, native]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 重新进入应用后立即检查排队请求。
  useEffect(() => {
    if (active && canOperate) void poll();
  }, [active, canOperate]);

  return null;
}

export function AndroidCaptureCoordinator() {
  const active = useAppActive();
  const environments = useWorkspaceEnvironments();
  if (
    !localScreenCapture?.captureEnvironmentRequest &&
    !localScreenCapture?.captureApprovedRequest
  ) {
    return null;
  }
  const native = localScreenCapture;
  return environments.map(({ isEnabled, environmentId, environmentLabel, connectionState }) =>
    isEnabled && connectionState === "connected" ? (
      <EnvironmentCaptureCoordinator
        key={environmentId}
        {...{
          active,
          environmentId,
          environmentLabel,
          native,
        }}
      />
    ) : null,
  );
}
