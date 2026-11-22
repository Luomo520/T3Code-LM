import { APP_VERSION } from "../../branding";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { InlineButton } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function AboutVersionTitle({ version = APP_VERSION }: { readonly version?: string }) {
  const { copyToClipboard } = useCopyToClipboard<void>({
    target: "version",
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy version",
          description: error.message,
        }),
      );
    },
  });

  return (
    <span className="inline-flex items-baseline gap-2">
      <span>运行版本</span>
      <code className="text-2xs font-medium">
        <Tooltip>
          <TooltipTrigger
            render={
              <InlineButton
                tone="muted"
                aria-label={`Copy version ${version}`}
                onClick={() => copyToClipboard(version, undefined)}
              >
                {version}
              </InlineButton>
            }
          />
          <TooltipPopup>Copy version</TooltipPopup>
        </Tooltip>
      </code>
    </span>
  );
}
