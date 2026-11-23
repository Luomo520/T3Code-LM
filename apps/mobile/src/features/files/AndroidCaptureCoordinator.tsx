import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AndroidCaptureInput,
  AndroidCaptureJob,
  AuthOrchestrationOperateScope,
  COMPANION_MAX_IMAGE_BYTES,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Device from "expo-device";
import { File } from "expo-file-system";
import { useEffect, useEffectEvent, useRef } from "react";
import { Alert, ToastAndroid } from "react-native";

import { connectionAtomRuntime } from "../../connection/runtime";
import { isAppActive, useAppActive } from "../../lib/appState";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { localScreenCapture } from "./localScreenCapture";

const captureCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:android-capture",
  execute: (payload: typeof AndroidCaptureInput.Type) =>
    executeConnectedEnvironmentHttpRequest({
      group: "companions",
      method: "POST",
      url: (urls) => urls.androidCapture(),
      timeoutMs: payload._tag === "complete" ? 25_000 : 8_000,
      requestInit: { redirect: "error" },
      request: ({ client, headers }) => client.androidCapture({ headers, payload }),
    }),
});

type Job = typeof AndroidCaptureJob.Type;
type NativeCapture = NonNullable<typeof localScreenCapture>;

// 应用同一时间只有一个原生对话框。跨环境请求保留排队，等待本机继续处理。
let pendingConfirmation: string | null = null;

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
  const request = (input: typeof AndroidCaptureInput.Type) => command({ environmentId, input });

  async function finish(
    input: Extract<typeof AndroidCaptureInput.Type, { _tag: "reject" | "complete" }>,
  ) {
    const response = await request(input);
    if (response._tag === "Success") return;
    // 传输结果已提交但未收到响应时，服务端接受相同结果的重试。
    await request(input);
  }

  async function capture(job: Job) {
    if (!available.current || current.current !== null || !native.captureApprovedRequest) return;
    current.current = job.id;
    const stillCurrent = () => current.current === job.id;
    let file: File | undefined;
    try {
      if (!isAppActive() || !(await native.isUnlocked())) {
        await finish({ _tag: "reject", id: job.id, reason: "locked" });
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
      backendApproved.current = true;
      const result = await native.captureApprovedRequest(
        job.action === "screenshot" ? "screenshot" : "recording",
        job.id,
        job.durationSeconds,
      );
      if (result.status !== "done") {
        await finish({
          _tag: "reject",
          id: job.id,
          reason: lockedRequest.current === job.id ? "locked" : result.status,
        });
        return;
      }
      file = new File(result.uri);
      if (!stillCurrent()) return;
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
      if (!stillCurrent()) return;
      if (unlocked) await finish({ _tag: "complete", id: job.id, media });
      else await finish({ _tag: "reject", id: job.id, reason: "locked" });
    } catch {
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
          await native.cancelCapture(running);
          await finish({ _tag: "reject", id: running, reason: "locked" });
          return;
        }
        if (!backendApproved.current) return;
        const status = await request({ _tag: "status", id: running });
        if (status._tag !== "Success" || status.value._tag === "inactive") {
          await native.cancelCapture(running);
        }
        return;
      }
      const existing = offered.current;
      if (existing && !(await native.isUnlocked())) {
        offered.current = null;
        if (pendingConfirmation === existing.id) pendingConfirmation = null;
        await finish({ _tag: "reject", id: existing.id, reason: "locked" });
        return;
      }
      if (!active || !isAppActive() || !available.current || !(await native.isUnlocked())) return;
      const response = await request({
        _tag: "listen",
        name: (Device.deviceName?.trim() || Device.modelName?.trim() || "Android 手机").slice(
          0,
          128,
        ),
      });
      if (
        !available.current ||
        !isAppActive() ||
        response._tag !== "Success" ||
        response.value._tag !== "pending"
      )
        return;
      const job = response.value.job;
      if (existing && existing.id !== job?.id) {
        offered.current = null;
        if (pendingConfirmation === existing.id) pendingConfirmation = null;
      }
      if (!job || presented.current === job.id || pendingConfirmation) return;
      offered.current = job;
      presented.current = job.id;
      pendingConfirmation = job.id;
      const isRecording = job.action === "record-screen";
      const decide = (approved: boolean) => {
        if (offered.current?.id !== job.id) return;
        offered.current = null;
        if (pendingConfirmation === job.id) pendingConfirmation = null;
        if (approved) void capture(job);
        else void finish({ _tag: "reject", id: job.id, reason: "denied" });
      };
      // 使用独立的 Android 原生对话框承接这次明确授权。
      Alert.alert(
        isRecording ? "允许本次录屏？" : "允许本次截图？",
        isRecording
          ? `「${environmentLabel}」的会话请求录屏，最长 ${job.durationSeconds} 秒。授权后，结果将发送回发起请求的会话。`
          : `「${environmentLabel}」的会话请求截图。授权后，截图将发送回发起请求的会话。`,
        [
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
    void poll();
    const timer = setInterval(() => void poll(), 4_000);
    return () => {
      clearInterval(timer);
      available.current = false;
      if (pendingConfirmation === offered.current?.id) pendingConfirmation = null;
      offered.current = null;
      const job = current.current;
      backendApproved.current = false;
      current.current = null;
      if (job) void native.cancelCapture(job).catch(() => {});
    };
  }, [canOperate, native]);

  return null;
}

export function AndroidCaptureCoordinator() {
  const active = useAppActive();
  const environments = useWorkspaceEnvironments();
  if (!localScreenCapture?.captureApprovedRequest) return null;
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
