import { CopyIcon, CheckIcon, DownloadIcon, FileIcon, RotateCwIcon } from "lucide-react";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { isAbsolutePath } from "@t3tools/shared/path";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

export function FileDownloadFallback(props: {
  readonly name: string;
  readonly sizeBytes?: number | undefined;
  readonly relativePath?: string | undefined;
  readonly reason?: string | undefined;
  readonly downloading?: boolean | undefined;
  readonly onDownload: () => void;
  readonly onRetry?: (() => void) | undefined;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: props.relativePath ?? "",
  });
  const extension = props.name.split(".").at(-1)?.toUpperCase();
  return (
    <div className="flex min-h-0 flex-1 overflow-auto scrollbar-gutter-both">
      <section aria-label="文件下载" className="m-auto w-full max-w-lg space-y-5 p-6">
        <div className="flex items-start gap-3">
          <FileIcon aria-hidden className="mt-1 size-7 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-1">
            <h3 className="break-all text-sm font-medium">{props.name}</h3>
            <p className="text-xs text-muted-foreground">
              {extension && extension !== props.name.toUpperCase() ? `${extension} 文件` : "文件"}
              {props.sizeBytes !== undefined ? ` · ${formatAttachmentSize(props.sizeBytes)}` : ""}
            </p>
          </div>
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">暂时无法在线预览</p>
          <p className="break-words text-xs leading-relaxed text-muted-foreground">
            {props.reason ?? "下载到本设备后，使用支持此格式的应用打开。"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={props.downloading} onClick={props.onDownload}>
            {props.downloading ? <Spinner /> : <DownloadIcon aria-hidden />}
            {props.downloading ? "正在准备…" : "下载"}
          </Button>
          {props.relativePath ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => copyToClipboard(props.relativePath ?? "", undefined)}
            >
              {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
              {isCopied
                ? "已复制"
                : isAbsolutePath(props.relativePath)
                  ? "复制完整路径"
                  : "复制相对路径"}
            </Button>
          ) : null}
          {props.onRetry ? (
            <Button type="button" variant="ghost" onClick={props.onRetry}>
              <RotateCwIcon aria-hidden />
              重试预览
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">大文件仅支持局域网下载</p>
      </section>
    </div>
  );
}
