import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useAppActive } from "../../lib/appState";
import { enqueueFileDownload, readFileDownload } from "../../lib/systemFileDownload";
import { useRefreshAssetUrl } from "../../state/assets";
import { useMediaActions } from "../../state/mediaActions";

type ScreenshotSaveProps = {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<AssetResource, { readonly _tag: "tool-output-image" }>;
  readonly fileName: string;
};

export function ScreenshotSaveButton(props: ScreenshotSaveProps) {
  return Platform.OS === "android" ? (
    <AndroidScreenshotSaveButton {...props} />
  ) : (
    <LibraryScreenshotSaveButton {...props} />
  );
}

function LibraryScreenshotSaveButton(props: ScreenshotSaveProps) {
  const { actions } = useMediaActions({
    environmentId: props.environmentId,
    resource: props.resource,
    name: props.fileName,
    mimeType: "image/png",
  });
  const action = actions.find(({ id }) => id === "save-image");
  return action ? (
    <Button label="保存到我的设备" onPress={action.run} disabled={action.disabled ?? false} />
  ) : null;
}

function AndroidScreenshotSaveButton(props: ScreenshotSaveProps) {
  const refresh = useRefreshAssetUrl(props.environmentId, props.resource);
  const appActive = useAppActive();
  const preparing = useRef(false);
  const [pending, setPending] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [result, setResult] = useState<{ message: string; error?: boolean } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 下载由 Android 服务执行，查询其最终结果供当前会话展示。
  useEffect(() => {
    if (!taskId || !appActive) return;
    let closed = false;
    let busy = false;
    const poll = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const task = await readFileDownload(taskId);
        if (closed) return;
        if (task && ["pending", "downloading", "paused"].includes(task.status)) return;
        setTaskId(null);
        setResult(
          task?.status === "downloaded"
            ? { message: "已保存到 Download/t3code" }
            : task?.status === "cancelled"
              ? { message: "下载已取消" }
              : { message: task?.error ?? "截图未保存，请重试。", error: true },
        );
      } catch {
        // 桥接暂时不可用时，仍可在下次查询读取原任务。
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 750);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [appActive, taskId]);

  const save = async () => {
    if (preparing.current || taskId) return;
    preparing.current = true;
    setPending(true);
    setResult(null);
    try {
      const url = await refresh();
      if (!url) throw new Error("截图暂不可用，请重新连接后重试。");
      setTaskId(await enqueueFileDownload(url, props.fileName));
    } catch (error) {
      setResult({
        message: error instanceof Error ? error.message : "截图未保存，请重试。",
        error: true,
      });
    } finally {
      preparing.current = false;
      setPending(false);
    }
  };

  return (
    <View className="gap-1.5">
      <Button
        label={pending || taskId ? "正在下载截图…" : "保存到我的设备"}
        icon="arrow.down.circle"
        loading={pending || taskId !== null}
        onPress={() => void save()}
      />
      {result ? (
        <AppText
          accessibilityLiveRegion="polite"
          className={
            result.error ? "text-sm text-danger-foreground" : "text-sm text-foreground-muted"
          }
        >
          {result.message}
        </AppText>
      ) : null}
    </View>
  );
}
