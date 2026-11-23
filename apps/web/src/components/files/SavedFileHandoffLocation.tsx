import type { DesktopSavedFileHandoffStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";

export function SavedFileHandoffLocation(props: {
  readonly threadId: string;
  readonly transferId: string;
}) {
  const locate = window.desktopBridge?.locateSavedFileHandoff;
  const { threadId, transferId } = props;
  const [status, setStatus] = useState<DesktopSavedFileHandoffStatus>("unknown");
  const [failed, setFailed] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 检查 Electron 下载器是否保存过该传输。
  useEffect(() => {
    if (!locate) return;
    let active = true;
    void locate({ threadId, transferId, reveal: false }).then(
      (value) => {
        if (active) setStatus(value);
      },
      () => {
        if (active) setStatus("unknown");
      },
    );
    return () => {
      active = false;
    };
  }, [locate, threadId, transferId]);

  if (!locate || status === "unknown") return null;
  if (status === "missing") {
    return (
      <span role="status" className="text-xs text-muted-foreground">
        文件已移动、删除或替换。
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          setFailed(false);
          void locate({ threadId, transferId, reveal: true }).then(
            (value) => setStatus(value === "unknown" ? "missing" : value),
            () => setFailed(true),
          );
        }}
      >
        打开所在位置
      </Button>
      {failed ? (
        <span role="status" className="text-xs text-destructive">
          暂时无法打开所在位置，请重试。
        </span>
      ) : null}
    </div>
  );
}
