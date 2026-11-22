import { replyPlainText } from "@t3tools/shared/replyClipboard";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { memo, useRef } from "react";
import { CheckIcon, CopyIcon, type LucideIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
} from "../ui/anchoredCopyToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  markdown,
  label = "Copy message",
  icon: Icon = CopyIcon,
  extraFlavors,
  size = "xs",
  variant = "outline",
  className,
}: {
  text: string;
  markdown?: string;
  label?: string;
  icon?: LucideIcon;
  extraFlavors?: Readonly<Record<string, string>>;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    ...(extraFlavors ? { extraFlavors } : {}),
  });

  if (markdown !== undefined) {
    return (
      <Menu>
        <MenuTrigger
          render={
            <Button ref={ref} type="button" size={size} variant="ghost-muted" aria-label={label} />
          }
        >
          {isCopied ? <CheckIcon className="size-3 text-primary" /> : <Icon className="size-3" />}
        </MenuTrigger>
        <MenuPopup side="top" align="start" width="content">
          <MenuItem onClick={() => void copyToClipboard(replyPlainText(text))}>复制正文</MenuItem>
          <MenuItem onClick={() => void copyToClipboard(markdown)}>复制 Markdown</MenuItem>
        </MenuPopup>
      </Menu>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={isCopied}
            onClick={() => copyToClipboard(text)}
            ref={ref}
            type="button"
            size={size}
            variant={variant === "ghost" ? "ghost-muted" : variant}
            className={className}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-primary" /> : <Icon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
});
