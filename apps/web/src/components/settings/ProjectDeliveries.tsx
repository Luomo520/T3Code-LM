import { projectDeliveryLabel } from "@t3tools/client-runtime/state/projects";
import {
  type EnvironmentId,
  type ProjectDelivery,
  type ProjectDeliveryPlatform,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useServerConfigs } from "~/state/entities";
import { WorkspaceDownloadButton } from "../files/WorkspaceDownloadButton";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

export type DeliveryFileTarget = {
  readonly environmentId: EnvironmentId;
  readonly file: ProjectDelivery;
};

export function DeliveryFileDialog(props: {
  readonly target: DeliveryFileTarget;
  readonly onClose: () => void;
}) {
  const { environmentId, file } = props.target;
  const [path, setPath] = useState(file.relativePath);
  const access = useFilesystemReadAccess(environmentId);
  const textFile = /\.(?:md|markdown|txt|json|csv|ya?ml|log|toml)$/i.test(path);
  const contents = useEnvironmentQuery(
    access.canReadFiles && textFile
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd: file.workspaceRoot, relativePath: path },
        })
      : null,
  );
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-words">{path.split("/").at(-1)}</DialogTitle>
          <DialogDescription className="break-words">
            {file.projectTitle} · {projectDeliveryLabel(file)}
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3 px-5 pb-5">
          {access.canReadFiles ? (
            <>
              {textFile &&
                (contents.data ? (
                  <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border p-3 text-sm">
                    {contents.data.contents}
                  </pre>
                ) : (
                  <p role="status" className="text-sm text-muted-foreground">
                    {contents.error ? "文件读取失败，请重试或下载。" : "正在读取文件…"}
                  </p>
                ))}
              {contents.data?.truncated && (
                <p className="text-sm text-muted-foreground">下载可查看完整文件。</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <WorkspaceDownloadButton
                  environmentId={environmentId}
                  resource={{
                    _tag: "draft-workspace-file",
                    cwd: file.workspaceRoot,
                    path,
                    disposition: "attachment",
                  }}
                />
                {file.notesPath && path !== file.notesPath && (
                  <Button variant="ghost" size="sm" onClick={() => setPath(file.notesPath!)}>
                    版本说明
                  </Button>
                )}
                {path !== file.relativePath && (
                  <Button variant="ghost" size="sm" onClick={() => setPath(file.relativePath)}>
                    返回交付文件
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">当前连接无法读取交付文件。</p>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function browserDeliveryPlatform(): ProjectDeliveryPlatform | undefined {
  const platform = navigator.platform.toLowerCase();
  if (/android/i.test(navigator.userAgent)) return "android";
  if (platform.includes("win")) return "windows";
  if (platform.includes("mac")) return "macos";
  if (platform.includes("linux")) return "linux";
  return undefined;
}

export function ProjectDeliveries(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 sm:px-4">
        项目交付{props.label ? ` · ${props.label}` : ""}
      </summary>
      {open && <ProjectDeliveryList {...props} />}
    </details>
  );
}

function ProjectDeliveryList(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const access = useFilesystemReadAccess(props.environmentId);
  const supportsDeliveries =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.projectDeliveries ===
    true;
  const [pages, setPages] = useState<readonly number[]>([0]);
  const offset = pages.at(-1) ?? 0;
  const [selected, setSelected] = useState<DeliveryFileTarget | null>(null);
  const [preferredPlatform] = useState(browserDeliveryPlatform);
  const [preferCurrentPlatform, setPreferCurrentPlatform] = useState(true);
  const result = useEnvironmentQuery(
    access.canReadFiles && supportsDeliveries
      ? projectEnvironment.listDeliveries({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            offset,
            ...(preferCurrentPlatform && preferredPlatform ? { preferredPlatform } : {}),
          },
        })
      : null,
  );
  return (
    <div className="space-y-2 px-3 pb-3 sm:px-4">
      {!access.canReadFiles || !supportsDeliveries ? (
        <p className="text-sm text-muted-foreground">当前连接无法读取交付文件。</p>
      ) : result.error ? (
        <div className="flex items-center gap-2 text-sm" role="status">
          交付文件读取失败。
          <Button variant="ghost" size="sm" onClick={result.refresh}>
            重试
          </Button>
        </div>
      ) : result.data === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取交付文件…
        </p>
      ) : (
        <>
          {result.data.files.length === 0 && (
            <p className="text-sm text-muted-foreground">此项目暂无交付文件。</p>
          )}
          {result.data.files.length > 0 && preferredPlatform && (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={preferCurrentPlatform}
              onClick={() => {
                setPages([0]);
                setPreferCurrentPlatform(!preferCurrentPlatform);
              }}
            >
              {preferCurrentPlatform ? "按全部平台日期排序" : "优先显示本机平台"}
            </Button>
          )}
          <ul className="divide-y rounded-md border">
            {result.data.files.map((file) => (
              <li key={file.relativePath}>
                <button
                  type="button"
                  className="w-full space-y-0.5 px-3 py-2 text-left hover:bg-muted focus-visible:outline-2"
                  onClick={() => setSelected({ environmentId: props.environmentId, file })}
                >
                  <span className="block wrap-break-word text-sm">{file.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {projectDeliveryLabel(file)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {(offset > 0 || result.data.nextOffset !== null) && (
            <div className="flex gap-2">
              {offset > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setPages(pages.slice(0, -1))}>
                  上一页
                </Button>
              )}
              {result.data.nextOffset !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPages([...pages, result.data!.nextOffset!])}
                >
                  下一页
                </Button>
              )}
            </div>
          )}
          {result.data.incomplete && (
            <p className="text-sm text-muted-foreground">部分交付目录未能读取。</p>
          )}
        </>
      )}
      {selected && <DeliveryFileDialog target={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
