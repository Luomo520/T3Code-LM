import { useRef, useState } from "react";
import { Download } from "lucide-react";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useWorkspaceDownloadUrl } from "~/assets/assetUrls";
import { toastManager } from "~/components/ui/toast";
import { Spinner } from "~/components/ui/spinner";
import { FileSurfaceAction } from "./fileSurfaceChrome";
import { startFileDownload } from "~/lib/fileDownload";
import { FileDownloadFallback } from "./FileDownloadFallback";

export function WorkspaceDownloadButton(props: {
  environmentId: EnvironmentId;
  resource: AssetResource;
  fallback?: {
    readonly name: string;
    readonly relativePath: string;
    readonly sizeBytes?: number | undefined;
  };
}) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const create = useWorkspaceDownloadUrl(props.environmentId, props.resource);
  const download = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await startFileDownload(await create());
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "下载未启动",
        description: error instanceof Error ? error.message : "请检查连接后重试。",
      });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  if (props.fallback) {
    return (
      <FileDownloadFallback
        {...props.fallback}
        downloading={pending}
        onDownload={() => void download()}
      />
    );
  }
  return (
    <FileSurfaceAction
      label={pending ? "正在申请下载…" : "下载到本机"}
      disabled={pending}
      onPress={() => {
        void download();
      }}
    >
      {pending ? <Spinner className="size-3.5" /> : <Download className="size-3.5" />}
    </FileSurfaceAction>
  );
}
