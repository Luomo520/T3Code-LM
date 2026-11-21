import { ScrollView, View } from "react-native";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { isAbsolutePath } from "@t3tools/shared/path";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

export function FileDownloadFallback(props: {
  readonly relativePath: string;
  readonly sizeBytes?: number;
  readonly reason?: string;
  readonly downloading: boolean;
  readonly downloadLabel: string;
  readonly onDownload?: () => void;
  readonly onRetry?: () => void;
}) {
  const name = props.relativePath.split(/[\\/]/).at(-1) || props.relativePath;
  const extension = name.split(".").at(-1)?.toUpperCase();
  return (
    <ScrollView className="flex-1 bg-sheet" contentContainerClassName="grow justify-center p-6">
      <View className="w-full max-w-lg self-center gap-5">
        <View className="gap-2">
          <AppText className="text-lg font-t3-semibold" selectable>
            {name}
          </AppText>
          <AppText className="text-sm text-foreground-muted">
            {extension && extension !== name.toUpperCase() ? `${extension} 文件` : "文件"}
            {props.sizeBytes !== undefined ? ` · ${formatAttachmentSize(props.sizeBytes)}` : ""}
          </AppText>
        </View>
        <View className="gap-2">
          <AppText className="font-t3-medium">暂时无法在线预览</AppText>
          <AppText className="text-sm text-foreground-muted">
            {props.reason ?? "下载到本设备后，使用支持此格式的应用打开。"}
          </AppText>
        </View>
        <View className="flex-row flex-wrap gap-3">
          {props.onDownload ? (
            <Button
              label={props.downloadLabel}
              tone="primary"
              icon="arrow.down.circle"
              loading={props.downloading}
              onPress={props.onDownload}
            />
          ) : null}
          <Button
            label={isAbsolutePath(props.relativePath) ? "复制完整路径" : "复制相对路径"}
            icon="doc.on.doc"
            onPress={() => void copyTextWithHaptic(props.relativePath)}
          />
          {props.onRetry ? <Button label="重试预览" tone="text" onPress={props.onRetry} /> : null}
        </View>
        {props.onDownload ? (
          <AppText className="text-sm text-foreground-muted">
            保存到 Download/t3code；大文件仅支持局域网下载。
          </AppText>
        ) : null}
      </View>
    </ScrollView>
  );
}
