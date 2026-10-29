// local patch (pi-app): shared scalable typography for UI annotations.
// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// beui.dev/components/agents/chat-app

// local patch (pi-app): use the shared UI icon adapter.
import {
  Braces,
  Check,
  ChevronDown,
  Copy,
  RotateCcw,
  SquareTerminal,
  Wrench,
} from "@/lib/icons";
// local patch (pi-app): the row's status mark is app-drawn, not a pack glyph.
import { StatusRing } from "@/lib/status-ring";
import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  AgentCode,
  type AgentCodeLanguage,
} from "@/components/agents/agent-code";
import { ActionSwapRollText } from "@/components/motion/action-swap-roll";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { SPRING_PRESS, SPRING_SWAP } from "@/lib/ease";
// local patch (pi-app): the output viewport's clipped edge fades instead of
// cutting a line (the app hides every scrollbar, so the cut had no other cue).
import { useScrollFade } from "@/lib/hooks/use-scroll-fade";
import { cn } from "@/lib/utils";
// local patch (pi-app): output caps follow whole lines at the code size.
import { codeLineHeight, useCodeFontSize } from "@/lib/typography";

export type ToolResultStatus = "running" | "success" | "error" | "cancelled";
export type ToolResultKind = "terminal" | "request" | "custom";

export interface ToolResultProps {
  /** Optional trailing label. Omitted when the title already names the tool. */
  tool?: ReactNode;
  title: ReactNode;
  children: ReactNode;
  status?: ToolResultStatus;
  kind?: ToolResultKind;
  meta?: ReactNode;
  icon?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapseOnComplete?: boolean;
  maxHeight?: number;
  copyText?: string;
  onCopy?: () => void | Promise<void>;
  onRetry?: () => void;
  className?: string;
  contentClassName?: string;
  /** local patch (pi-app): disable blur/roll text swaps for hot tool rows. */
  animateChanges?: boolean;
  /** local patch (pi-app): do not mount expensive output while collapsed. */
  lazyContent?: boolean;
  /**
   * local patch (pi-app): content pinned INSIDE the frame, above the output's
   * scroll viewport and separated from it by the frame's divider — a bash
   * row's full command stays visible while long output scrolls beneath it.
   * Only meaningful for the framed (non-`bare`) body.
   */
  header?: ReactNode;
  /**
   * local patch (pi-app): render the body WITHOUT its framed output box — the
   * content sits directly on the transcript at the row's own indent. A tool
   * whose output is an image shows that image alone, so a muted frame with 12px
   * inner padding, a height cap and a copy footer would only box a picture.
   */
  bare?: boolean;
}
export interface ToolResultOutputProps {
  children: string;
  language?: AgentCodeLanguage;
  /** local patch (pi-app): skip Shiki while cumulative output is growing. */
  highlight?: boolean;
  className?: string;
}

function getStatusLabel(status: ToolResultStatus) {
  if (status === "running") return "Running";
  if (status === "success") return "Completed";
  if (status === "error") return "Failed";
  return "Cancelled";
}

function getSwapKey(value: ReactNode, fallback: string) {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function getStatusClass(status: ToolResultStatus) {
  if (status === "running") {
    return "text-blue-600 dark:text-blue-400";
  }
  if (status === "success") {
    return "text-emerald-600 dark:text-emerald-400";
  }
  if (status === "error") {
    return "text-rose-600 dark:text-rose-400";
  }
  return "text-muted-foreground";
}

function KindIcon({ kind }: { kind: ToolResultKind }) {
  if (kind === "terminal") return <SquareTerminal className="size-4" />;
  if (kind === "request") return <Braces className="size-4" />;
  return <Wrench className="size-4" />;
}

// local patch (pi-app): the status mark is the task strip's shared circle
// (`lib/status-ring`): the icon adapter's own `circle-check` / `circle-x` /
// `ban` artwork for a settled row, and the drawn spinning 3/4 arc while it
// runs. Both are the marks the todo rows and the sidebar's live spin already
// draw, so one glance reads all three panels the same way.
function StatusIcon({
  status,
  reduce,
}: {
  status: ToolResultStatus;
  reduce: boolean;
}) {
  return <StatusRing status={status} reduce={reduce} className="size-3" />;
}

function ToolResultAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      // local patch (pi-app): no press scale — a tool-row icon button must not
      // dip inward while pressed (see `button/base`).
      transition={SPRING_PRESS}
      className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </motion.button>
  );
}

export function ToolResultOutput({
  children,
  language = "bash",
  highlight = true,
  className,
}: ToolResultOutputProps) {
  return (
    <AgentCode
      code={children}
      language={language}
      highlight={highlight}
      className={cn(
        // local patch (pi-app): tool output uses the same contrast as reply content.
        "whitespace-pre-wrap break-words text-foreground",
        className,
      )}
    />
  );
}

/**
 * local patch (pi-app): the output cap lands on a LINE boundary — the height
 * shows whole lines, never a half one.
 *
 * The 12px body padding is INSIDE the scrollport, so the fold sits on a line
 * boundary at `padding + lines × line`: default 12 + 11 × 20 = 232.
 * The vendored 220 left a 208px
 * content area — 10.4 lines — so the line at the fold was sliced in half.
 */
const OUTPUT_PADDING = 12;
const OUTPUT_LINES = 11;

export function ToolResult({
  tool,
  title,
  children,
  status = "running",
  kind = "custom",
  meta,
  icon,
  open,
  defaultOpen = true,
  onOpenChange,
  collapseOnComplete = true,
  maxHeight,
  copyText,
  onCopy,
  onRetry,
  className,
  contentClassName,
  animateChanges = true,
  lazyContent = false,
  header,
  bare = false,
}: ToolResultProps) {
  const reduce = useReducedMotion() ?? false;
  const rowHeight = codeLineHeight(useCodeFontSize());
  const viewportHeight = maxHeight === undefined
    ? OUTPUT_PADDING + rowHeight * OUTPUT_LINES
    : OUTPUT_PADDING + Math.max(rowHeight, Math.floor((maxHeight - OUTPUT_PADDING) / rowHeight) * rowHeight);
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef(status);
  const copyTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = open ?? internalOpen;
  // local patch (pi-app): a mask on whichever end of the cap hides output. The
  // body is lazy, so the measurement follows the disclosure's own state.
  const { edges: fadeEdges, maskImage } = useScrollFade(viewportRef, { dependsOn: currentOpen });
  const running = status === "running";
  const canCopy = Boolean(copyText || onCopy);
  const titleKey = getSwapKey(title, status);
  const metaKey = getSwapKey(meta, `${status}-meta`);
  const toolKey = getSwapKey(tool, `${status}-tool`);
  const statusLabel = getStatusLabel(status);

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, open],
  );

  useEffect(() => {
    if (previousStatus.current !== "running" && status === "running") {
      setOpen(true);
    }
    if (
      previousStatus.current === "running" &&
      status !== "running" &&
      collapseOnComplete
    ) {
      setOpen(false);
    }
    previousStatus.current = status;
  }, [collapseOnComplete, setOpen, status]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !currentOpen || !running) return;

    const frame = requestAnimationFrame(() => {
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          // local patch (pi-app): cumulative tool output can update rapidly;
          // restarting smooth scrolling per update monopolizes the main thread.
          behavior: "auto",
        });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy();
    else if (copyText) await navigator.clipboard?.writeText(copyText);

    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [copyText, onCopy]);

  return (
    <div
      data-state={status}
      aria-busy={running}
      className={cn("w-full text-sm", className)}
    >
      <button
        // local patch (pi-app): app-owned transcript geometry hook.
        data-agent-trigger=""
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        // local patch (pi-app): transcript disclosures stay unfilled on hover.
        className="group flex min-h-9 w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span
          aria-hidden="true"
          className="grid size-4 shrink-0 place-items-center text-muted-foreground"
        >
          {icon ?? <KindIcon kind={kind} />}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          {/* local patch (pi-app): tool titles use primary contrast; the smaller
              metadata keeps its muted colour on this shared baseline. Data
              markers let the shared row geometry regression cover every host. */}
          {/* local patch (pi-app): centre the title and metadata by their type
              area while retaining their shared baseline and truncation. */}
          <span data-tool-result-title="" className="transcript-label min-w-0 truncate font-medium text-foreground">
            {animateChanges ? (
              <ActionSwapRollText value={titleKey}>{title}</ActionSwapRollText>
            ) : (
              title
            )}
          </span>
          {meta ? (
            <span data-tool-result-meta="" className="transcript-label shrink-0 text-xs text-muted-foreground/60">
              {animateChanges ? (
                <ActionSwapRollText value={metaKey}>{meta}</ActionSwapRollText>
              ) : (
                meta
              )}
            </span>
          ) : null}
          {/* local patch (pi-app): the header title already starts with the tool
              name (`bash · …`), so the trailing copy was a duplicate that stole
              the width the title needs. Render it only when a caller supplies
              one (beUI previews still do). */}
          {tool ? (
            <span className="transcript-label min-w-0 truncate font-mono text-caption text-muted-foreground/55">
              {animateChanges ? (
                <ActionSwapRollText value={toolKey}>{tool}</ActionSwapRollText>
              ) : (
                tool
              )}
            </span>
          ) : null}
        </span>
        {/* local patch (pi-app): the trailing status word was removed — the row
            now reads from the glyph alone (spinner = running, check = done, x =
            failed), keeping the header quiet and the title roomy. The word
            stays for screen readers. */}
        <span
          className={cn(
            "inline-flex shrink-0 items-center text-caption font-medium",
            getStatusClass(status),
          )}
        >
          <StatusIcon status={status} reduce={reduce} />
          <span className="sr-only">{statusLabel}</span>
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>

      <AgentDisclosure
        // local patch (pi-app): only a real row body owns a leading gap.
        data-agent-body={true}
        id={contentId}
        role="region"
        aria-labelledby={triggerId}
        open={currentOpen}
      >
        {lazyContent && !currentOpen ? null : (
          // local patch (pi-app): `pl-6` is the row's own text indent (16px icon
          // + 8px gap), so an expanded body starts exactly where the title does.
          <div className="pl-6 pt-1.5" data-tool-body={bare ? "bare" : "framed"}>
            {bare ? (
              <div className={cn("min-w-0", contentClassName)}>{children}</div>
            ) : (
              <div className="overflow-hidden rounded-xl bg-muted/80">
                {header ? (
                  <div data-tool-header="" className="border-b border-border/60">
                    {header}
                  </div>
                ) : null}
                <div
                  ref={viewportRef}
                  role="log"
                  aria-live="polite"
                  data-fade={fadeEdges.top && fadeEdges.bottom ? "both" : fadeEdges.bottom ? "bottom" : fadeEdges.top ? "top" : "none"}
                  className="scrollbar-hide overflow-y-auto"
                  style={{ maxHeight: viewportHeight, maskImage, WebkitMaskImage: maskImage }}
                >
                  <div className={cn("p-3", contentClassName)}>{children}</div>
                </div>

                {canCopy || onRetry ? (
                  <div className="flex items-center gap-0.5 px-2 pb-1.5">
                    {canCopy ? (
                      <ToolResultAction
                        label={copied ? "Copied" : "Copy result"}
                        onClick={handleCopy}
                      >
                        {copied ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                      </ToolResultAction>
                    ) : null}
                    {onRetry ? (
                      <ToolResultAction label="Run again" onClick={onRetry}>
                        <RotateCcw className="size-3.5" />
                      </ToolResultAction>
                    ) : null}
                    <span className="ml-auto text-caption text-muted-foreground/55">
                      {animateChanges ? (
                        <ActionSwapRollText value={status}>{statusLabel}</ActionSwapRollText>
                      ) : (
                        statusLabel
                      )}
                    </span>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </AgentDisclosure>
    </div>
  );
}
