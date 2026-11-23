import type { ToolCallDiffTarget } from "../../diffPanelStore";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import {
  companionRecordingOutput,
  companionScreenshotOutput,
  isJsonToolText,
  toolCallLines,
  threadFileSaveOutput,
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { isJavaScriptReplTool } from "@t3tools/shared/toolActivity";
import { Download, ExternalLinkIcon } from "lucide-react";
import { memo, type ReactNode, Suspense, use, useRef, useState } from "react";

import { useAssetUrlRefresh } from "../../assets/assetUrls";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { useTurnItemDetail } from "../../state/queries";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { Button } from "../ui/button";
import { FileHandoffPanel } from "../files/FileHandoffPanel";
import { toastManager } from "../ui/toast";
import { downloadMedia } from "../media/mediaContent";
import ChatMarkdown from "../ChatMarkdown";
import { CompanionRecordingPlayer } from "./CompanionRecordingPlayer";
import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { resolveExternalWebLinkHref } from "./externalLinkContextMenu";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { ShellCommandBlock } from "./ShellCommandBlock";
import { useInitialOutputReady, type TurnItemSource } from "./timelineRowContext";

interface V2ItemInspectorProps {
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onOpenToolDiff?: ((target: ToolCallDiffTarget) => void) | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly source?: TurnItemSource | undefined;
}

function SyntaxTokens({
  text,
  language,
}: {
  readonly text: string;
  readonly language: "json" | "typescript" | "html";
}) {
  const resolvedTheme = useRenderedAppearance();
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const { tokens } = highlighter.codeToTokens(text, {
    lang: language,
    theme: resolveDiffThemeName(resolvedTheme),
  });
  return tokens.flatMap((line, lineIndex) => [
    lineIndex > 0 ? "\n" : "",
    ...line.map((token) => (
      <span key={token.offset} style={{ color: token.color }}>
        {token.content}
      </span>
    )),
  ]);
}

const monoClassName =
  "font-mono text-(length:--font-size-code,var(--text-2xs)) leading-relaxed whitespace-pre-wrap break-words select-text";

function StructuredValue({
  value,
  highlightJson = false,
  language,
}: {
  readonly value: unknown;
  readonly highlightJson?: boolean;
  readonly language?: "typescript" | "html" | "json";
}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const isJson = highlightJson && isJsonToolText(text);
  if (!text) return null;
  return (
    <pre className={cn("max-h-80 overflow-auto text-muted-foreground", monoClassName)}>
      {language || isJson ? (
        <RenderErrorBoundary fallback={text}>
          <Suspense fallback={text}>
            <SyntaxTokens text={text} language={language ?? "json"} />
          </Suspense>
        </RenderErrorBoundary>
      ) : (
        text
      )}
    </pre>
  );
}

function useFetchedTurnItem(
  projectedItem: OrchestrationV2ProjectedTurnItem,
  environmentId: EnvironmentId,
  source: TurnItemSource | undefined,
  skip = false,
) {
  const wireItem = projectedItem.item;
  const fetches = !skip && turnItemNeedsDetailFetch(wireItem);
  const detail = useTurnItemDetail(
    fetches
      ? {
          environmentId,
          threadId: projectedItem.sourceThreadId,
          itemId: projectedItem.sourceItemId,
          revision: turnItemDetailRevision(wireItem),
        }
      : null,
    source?.detail,
  );
  const fetchedItem = detail.data?.item;
  const item = fetchedItem?.type === wireItem.type ? fetchedItem : wireItem;
  const screenshot = companionScreenshotOutput(item);
  return {
    item,
    output: {
      output: screenshot?.summary ? null : turnItemOutputText(item),
      images: turnItemOutputImages(item),
      screenshot,
      recording: companionRecordingOutput(item),
      environmentId,
      pending: item === wireItem && detail.isPending,
      error:
        item !== wireItem
          ? null
          : detail.data?.item === null
            ? "Output is no longer available."
            : detail.error,
      empty: fetches && item !== wireItem,
    },
  };
}

interface ToolOutputState {
  readonly output: string | null;
  readonly images: ReturnType<typeof turnItemOutputImages>;
  readonly screenshot?: ReturnType<typeof companionScreenshotOutput>;
  readonly recording?: ReturnType<typeof companionRecordingOutput>;
  readonly environmentId: EnvironmentId;
  readonly pending: boolean;
  readonly error: string | null;
  readonly empty: boolean;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

function ScreenshotSaveButton(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: ToolOutputState["images"][number];
  readonly fileName: string;
}) {
  const refresh = useAssetUrlRefresh(props.environmentId, props.resource);
  const saving = useRef(false);
  const [pending, setPending] = useState(false);
  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    try {
      const url = await refresh();
      if (!url) throw new Error("截图暂不可用，请重新连接后重试。");
      await downloadMedia(url, props.fileName);
      toastManager.add({ type: "info", title: "已交给当前设备下载", description: props.fileName });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "截图保存失败",
        description: error instanceof Error ? error.message : "请检查连接后重试。",
      });
    } finally {
      saving.current = false;
      setPending(false);
    }
  };
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      aria-busy={pending}
      onClick={(event) => {
        event.stopPropagation();
        void save();
      }}
    >
      <Download aria-hidden="true" />
      {pending ? "正在下载截图…" : "保存到我的设备"}
    </Button>
  );
}

function ToolOutputImages(props: ToolOutputState) {
  return props.images.map((resource, index) => {
    const screenshot = index === 0 ? props.screenshot : null;
    const image = (
      <ChatMarkdownAssetImage
        key={resource.index}
        environmentId={props.environmentId}
        resource={resource}
        alt={screenshot ? "设备截图" : "Tool output image"}
        maxHeightRem={16}
        onImageExpand={props.onImageExpand}
      />
    );
    return screenshot ? (
      <figure key={resource.index} className="space-y-2 font-sans">
        {screenshot.summary ? <figcaption>{screenshot.summary}</figcaption> : null}
        <div>{image}</div>
        <ScreenshotSaveButton
          environmentId={props.environmentId}
          resource={resource}
          fileName={screenshot.fileName}
        />
      </figure>
    ) : (
      image
    );
  });
}

function ToolOutput(props: ToolOutputState) {
  if (props.recording) {
    return (
      <CompanionRecordingPlayer
        key={props.recording.url}
        recording={props.recording}
        environmentId={props.environmentId}
      />
    );
  }
  return props.output ? (
    <StructuredValue value={props.output} highlightJson />
  ) : props.pending ? (
    <div className="text-muted-foreground italic">Loading output…</div>
  ) : props.error ? (
    <div className="text-destructive">Couldn&apos;t load output: {props.error}</div>
  ) : props.empty && props.images.length === 0 ? (
    <div className="text-muted-foreground italic">No output.</div>
  ) : null;
}

export function FetchedToolOutput(props: {
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly source?: TurnItemSource | undefined;
}) {
  const { item, output } = useFetchedTurnItem(
    props.projectedItem,
    props.environmentId,
    props.source,
  );
  useInitialOutputReady(output.pending, props.onInitialOutputReady);
  const fileSave = threadFileSaveOutput(item);
  if (fileSave) {
    return (
      <div className="mt-1.5 space-y-1.5 text-xs">
        <p>{fileSave.text}</p>
        {fileSave.status === "awaiting_save" && (
          <FileHandoffPanel
            thread={{ environmentId: props.environmentId, threadId: item.threadId }}
          />
        )}
      </div>
    );
  }
  return (
    <div className={cn("mt-1.5 space-y-1.5", monoClassName)}>
      <ToolOutputImages {...output} onImageExpand={props.onImageExpand} />
      <ToolOutput {...output} onImageExpand={props.onImageExpand} />
    </div>
  );
}

function ToolCallBody(
  props: ToolOutputState & {
    readonly command?: string;
    readonly args?: unknown;
    readonly toolName?: string | null;
    readonly exitCode?: number | undefined;
    /** Replaces fetched output. */
    readonly outputSlot?: ReactNode;
  },
) {
  const call = toolCallLines({ command: props.command, args: props.args });
  return (
    <div className={cn("space-y-1.5", monoClassName)}>
      <ToolOutputImages {...props} />
      {call.command ? <ShellCommandBlock command={call.command} /> : null}
      {call.args ? (
        <div className="text-foreground/85">
          {call.args.map(([key, value]) => (
            <div key={key}>
              <span className="text-muted-foreground">{key} </span>
              {key === "html" ? (
                <StructuredValue value={value} language="html" />
              ) : key === "code" && isJavaScriptReplTool(props.toolName) ? (
                <StructuredValue value={value} language="typescript" />
              ) : isJsonToolText(value) ? (
                <StructuredValue value={value} language="json" />
              ) : (
                value
              )}
            </div>
          ))}
        </div>
      ) : null}
      {call.argsText ? <StructuredValue value={call.argsText} highlightJson /> : null}
      {props.outputSlot ?? <ToolOutput {...props} />}
      {props.exitCode !== undefined && props.exitCode !== 0 ? (
        <div className="text-destructive">exit {props.exitCode}</div>
      ) : null}
    </div>
  );
}

export const V2ItemInspector = memo(function V2ItemInspector(props: V2ItemInspectorProps) {
  // Command rows stream their output, including the final output, from the server.
  const environmentStreamsOutput = useCommandOutputStreaming(props.environmentId);
  const streamsOutput =
    (props.source !== undefined || environmentStreamsOutput) &&
    props.projectedItem.item.type === "command_execution";
  const fetched = useFetchedTurnItem(
    props.projectedItem,
    props.environmentId,
    props.source,
    streamsOutput,
  );
  const item = fetched.item;
  const outputState = fetched.output;
  const fileSave = threadFileSaveOutput(item);
  useInitialOutputReady(streamsOutput || outputState.pending, props.onInitialOutputReady);
  return (
    <div className="space-y-2 text-xs" data-v2-item-inspector={item.type}>
      {item.type === "reasoning" && item.text ? (
        <div className="rounded-md border border-border/45 bg-muted/15 p-2 italic text-muted-foreground">
          <ChatMarkdown
            text={item.text}
            cwd={props.cwd}
            threadRef={{
              environmentId: props.environmentId,
              threadId: props.projectedItem.sourceThreadId,
            }}
            lineBreaks
          />
        </div>
      ) : null}

      {item.type === "command_execution" ? (
        <ToolCallBody
          command={item.input}
          exitCode={item.exitCode}
          {...outputState}
          onImageExpand={props.onImageExpand}
          outputSlot={
            streamsOutput ? (
              <CommandOutputPanel
                onInitialOutputReady={props.onInitialOutputReady}
                environmentId={props.environmentId}
                threadId={props.projectedItem.sourceThreadId}
                itemId={props.projectedItem.sourceItemId}
                source={props.source?.commandOutput}
              />
            ) : undefined
          }
        />
      ) : null}

      {item.type === "file_change" ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-muted-foreground">
              {formatWorkspaceRelativePath(item.fileName, props.workspaceRoot)}
            </span>
            {item.additions !== undefined || item.deletions !== undefined ? (
              <span>
                <span className="text-diff-addition">+{formatDiffCount(item.additions ?? 0)}</span>{" "}
                <span className="text-diff-deletion">-{formatDiffCount(item.deletions ?? 0)}</span>
              </span>
            ) : null}
            {props.onOpenToolDiff ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  props.onOpenToolDiff?.({
                    threadId: props.projectedItem.sourceThreadId,
                    itemId: props.projectedItem.sourceItemId,
                    revision: turnItemDetailRevision(item),
                  })
                }
              >
                Open diff
              </Button>
            ) : null}
          </div>
          {item.status === "failed" && item.diffStr?.trim() ? (
            <StructuredValue value={item.diffStr} />
          ) : null}
          {item.changes !== undefined && item.changes.length > 0 ? (
            <ul className="space-y-1 font-mono text-muted-foreground">
              {item.changes.map((change) => (
                <li key={JSON.stringify([change.operation, change.oldPath, change.path])}>
                  {change.operation} {change.oldPath ? `${change.oldPath} → ` : ""}
                  {formatWorkspaceRelativePath(change.path, props.workspaceRoot)}
                  {change.fileType || change.mimeType
                    ? ` (${[change.fileType, change.mimeType].filter(Boolean).join(", ")})`
                    : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {item.type === "file_search" && item.pattern?.trim() ? (
        <div className={cn("text-foreground/85", monoClassName)}>{item.pattern}</div>
      ) : null}

      {item.type === "web_search" && item.patterns?.length ? (
        <div className={cn("text-foreground/85", monoClassName)}>{item.patterns.join("\n")}</div>
      ) : null}

      {item.type === "file_search" && item.results?.length ? (
        <ul className="space-y-1">
          {item.results.map((result) => (
            <li key={JSON.stringify(result)}>
              <span className="font-mono text-foreground/80">
                {formatWorkspaceRelativePath(result.fileName, props.workspaceRoot)}
                {result.line === undefined ? "" : `:${result.line}`}
                {result.column === undefined ? "" : `:${result.column}`}
              </span>
              {result.preview ? (
                <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{result.preview}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {item.type === "web_search" && item.results?.length ? (
        <ul className="space-y-1.5">
          {item.results.map((result) => {
            const safeHref = resolveExternalWebLinkHref(result.url);
            return (
              <li key={JSON.stringify(result)}>
                {safeHref ? (
                  <a
                    href={safeHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                  >
                    {result.title ?? result.url}
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : (
                  <p className="font-medium text-foreground">
                    {result.title ?? result.url ?? "Search result"}
                  </p>
                )}
                {result.snippet ? <p className="text-muted-foreground">{result.snippet}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {fileSave ? (
        <div className="space-y-1.5">
          <p>{fileSave.text}</p>
          {fileSave.status === "awaiting_save" && (
            <FileHandoffPanel
              thread={{ environmentId: props.environmentId, threadId: item.threadId }}
            />
          )}
        </div>
      ) : item.type === "dynamic_tool" ? (
        <ToolCallBody
          toolName={item.toolName}
          args={item.input}
          {...outputState}
          onImageExpand={props.onImageExpand}
        />
      ) : null}

      {item.type === "approval_request" ? <StructuredValue value={item.prompt} /> : null}
      {item.type === "user_input_request" ? (
        <StructuredValue
          value={item.questions
            .map((question) =>
              [question.question, ...question.options.map((option) => `• ${option.label}`)].join(
                "\n",
              ),
            )
            .join("\n\n")}
        />
      ) : null}
      {item.type === "notification" ? <StructuredValue value={item.detail} /> : null}
      {item.type === "system_notice" ? <StructuredValue value={item.message} /> : null}
      {item.type === "error" ? <StructuredValue value={item.failure.message} /> : null}
      {item.type === "todo_list" ? (
        <StructuredValue
          value={item.steps
            .map(
              (step) =>
                `${step.status === "completed" ? "✓" : step.status === "running" ? "◉" : "○"} ${step.text}`,
            )
            .join("\n")}
        />
      ) : null}
    </div>
  );
});
