// local patch (pi-app): shared scalable typography for content and code.
// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// beui.dev/components/agents/chat-app

// local patch (pi-app): use the shared UI icon adapter.
import {
  Check,
  ChevronDown,
  Copy,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
} from "@/lib/icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  type CitationItem,
  CitationList,
  CitationStack,
} from "@/components/agents/citations";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { DURATION, EASE_OUT, SPRING_PRESS, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type StreamingResponseStatus = "streaming" | "complete" | "error";
export type StreamingResponseFeedback = "up" | "down" | null;

export interface StreamingResponseProps {
  /** Rendered response content. Pass plain text or the output of a Markdown renderer. */
  children: ReactNode;
  status?: StreamingResponseStatus;
  /** Plain-text value copied by the built-in copy action. */
  copyText?: string;
  /** Overrides the built-in clipboard action. */
  onCopy?: () => void | Promise<void>;
  onRetry?: () => void;
  /** Optional sources shown as a compact footer disclosure after streaming. */
  sources?: CitationItem[];
  sourcesOpen?: boolean;
  defaultSourcesOpen?: boolean;
  onSourcesOpenChange?: (open: boolean) => void;
  sourceIdPrefix?: string;
  feedback?: StreamingResponseFeedback;
  defaultFeedback?: StreamingResponseFeedback;
  onFeedbackChange?: (feedback: StreamingResponseFeedback) => void;
  /** Set false when a surrounding conversation log announces streamed text. */
  announce?: boolean;
  /** Hides the built-in completion actions without changing response status. */
  showActions?: boolean;
  // local patch (pi-app): extra action cells (retry/fork) rendered inside the
  // completion-actions row, before the `meta` timestamp cell so the timestamp
  // stays rightmost.
  actions?: ReactNode;
  // local patch (pi-app): slot for the turn's timestamp, rendered as one more
  // cell of the completion-actions row so it shares the row's spacing.
  meta?: ReactNode;
  // local patch (pi-app): turn-level content that belongs between the answer and
  // its completion-actions row (the files the turn wrote).
  footer?: ReactNode;
  className?: string;
  contentClassName?: string;
  actionsClassName?: string;
}

function ResponseAction({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={label === "Helpful" || label === "Not helpful" ? active : undefined}
      onClick={onClick}
      // local patch (pi-app): no press scale — a message action button must not
      // dip inward while pressed (see `button/base`).
      transition={SPRING_PRESS}
      className={cn(
        "grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
        active && "bg-muted text-foreground",
      )}
    >
      {children}
    </motion.button>
  );
}

export function StreamingResponse({
  children,
  status = "streaming",
  copyText,
  onCopy,
  onRetry,
  sources = [],
  sourcesOpen,
  defaultSourcesOpen = false,
  onSourcesOpenChange,
  sourceIdPrefix,
  feedback,
  defaultFeedback = null,
  onFeedbackChange,
  announce = true,
  showActions = true,
  actions,
  meta,
  footer,
  className,
  contentClassName,
  actionsClassName,
}: StreamingResponseProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const [copied, setCopied] = useState(false);
  const [internalFeedback, setInternalFeedback] =
    useState<StreamingResponseFeedback>(defaultFeedback);
  const [internalSourcesOpen, setInternalSourcesOpen] =
    useState(defaultSourcesOpen);
  const copyTimer = useRef<number | undefined>(undefined);
  const currentFeedback = feedback ?? internalFeedback;
  const currentSourcesOpen = sourcesOpen ?? internalSourcesOpen;
  const streaming = status === "streaming";
  const complete = status === "complete";
  const canCopy = Boolean(copyText || onCopy);
  const hasSources = sources.length > 0;
  const shouldShowActions =
    showActions && !streaming && (canCopy || onRetry || complete || hasSources);
  const sourcesContentId = `${baseId}-sources`;
  const resolvedSourcePrefix =
    sourceIdPrefix ?? `response-source-${baseId.replace(/:/g, "")}`;

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy();
    else if (copyText) await navigator.clipboard?.writeText(copyText);

    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [copyText, onCopy]);

  const setFeedback = (next: Exclude<StreamingResponseFeedback, null>) => {
    const value = currentFeedback === next ? null : next;
    if (feedback === undefined) setInternalFeedback(value);
    onFeedbackChange?.(value);
  };

  const setSourcesOpen = useCallback(
    (next: boolean) => {
      if (sourcesOpen === undefined) setInternalSourcesOpen(next);
      onSourcesOpenChange?.(next);
    },
    [onSourcesOpenChange, sourcesOpen],
  );

  return (
    <div
      data-state={status}
      aria-busy={streaming}
      className={cn("w-full", className)}
    >
      <div
        aria-live={announce ? "polite" : "off"}
        className={cn(
          // local patch (pi-app): inline code takes the theme's detail radius.
          // The vendored descendant utility pinned a literal 0.25rem radius
          // (Tailwind's bare radius step, not a token), and an ancestor's
          // descendant utility beats the markdown element's own token class on
          // specificity, so every inline code box in the transcript stayed
          // rounded. Kept out of this comment: the literal utility name —
          // Tailwind's scanner reads comments and would generate it again.
          // local patch (pi-app): inline and fenced code use fixed type steps.
          // local patch (pi-app): the raw-fence code rules stay off beUI's own
          // CodeBlock (its pre is marked `data-code-block-pre`, like the frame
          // rules beside them). An ancestor's descendant rule is a DIRECT
          // declaration on that inner code element, so it beat the size the
          // component declares on its pre and every fenced block in a reply
          // rendered one step larger than inline code, tool output, diffs and
          // the file viewer — the transcript's only oversized code. Guarding
          // it lets the block keep its own fixed step; a raw fence (no
          // CodeBlock) still gets the app's framing.
          // local patch (pi-app): reply prose uses the full primary text contrast.
          "text-content text-foreground [&_a]:font-medium [&_a]:underline [&_a]:underline-offset-4 [&_code]:rounded-detail [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-code-inline [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_p+p]:mt-3 [&_pre:not([data-code-block-pre])]:my-3 [&_pre:not([data-code-block-pre])]:overflow-x-auto [&_pre:not([data-code-block-pre])]:rounded-xl [&_pre:not([data-code-block-pre])]:border [&_pre:not([data-code-block-pre])]:border-border [&_pre:not([data-code-block-pre])]:bg-muted/45 [&_pre:not([data-code-block-pre])]:p-3 [&_pre:not([data-code-block-pre])_code]:bg-transparent [&_pre:not([data-code-block-pre])_code]:p-0 [&_pre:not([data-code-block-pre])_code]:rounded-none [&_pre:not([data-code-block-pre])_code]:text-code [&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
          contentClassName,
        )}
      >
        {children}
      </div>

      {/* local patch (pi-app): the footer sits above the completion actions, so a
          turn can list what it changed and still end on the action row. */}
      {footer ? <div className="mt-3">{footer}</div> : null}

      <AnimatePresence initial={false}>
        {shouldShowActions ? (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            // local patch (pi-app): use the app's shared content duration for
            // the completion-actions row instead of a one-off literal.
            transition={{ duration: reduce ? 0.12 : DURATION.base, ease: EASE_OUT }}
            // local patch (pi-app): all transcript action groups share the
            // same leading gap, including standalone retry/fork footers.
            data-message-actions
          >
            <div className={cn("flex items-center gap-0.5", actionsClassName)}>
              {canCopy ? (
                <ResponseAction
                  label={copied ? "Copied" : "Copy response"}
                  onClick={handleCopy}
                >
                  {copied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </ResponseAction>
              ) : null}
              {onRetry ? (
                <ResponseAction label="Retry response" onClick={onRetry}>
                  <RotateCcw className="size-3.5" />
                </ResponseAction>
              ) : null}
              {/* local patch (pi-app): the feedback thumbs are only meaningful
                  when the host wires them up. The app never passes
                  `onFeedbackChange`/`feedback`, so rendering them produced
                  buttons that highlighted and then did nothing. */}
              {complete && (onFeedbackChange || feedback !== undefined) ? (
                <>
                  <ResponseAction
                    label="Helpful"
                    active={currentFeedback === "up"}
                    onClick={() => setFeedback("up")}
                  >
                    <ThumbsUp className="size-3.5" />
                  </ResponseAction>
                  <ResponseAction
                    label="Not helpful"
                    active={currentFeedback === "down"}
                    onClick={() => setFeedback("down")}
                  >
                    <ThumbsDown className="size-3.5" />
                  </ResponseAction>
                </>
              ) : null}
              {/* local patch (pi-app): app-supplied actions (retry/fork) share
                  the row, immediately after the feedback cells. */}
              {actions}
              {/* local patch (pi-app): same cell padding as a ResponseAction, so
                  the gap to the icons matches the gap between them. */}
              {meta ? (
                <span className="flex min-h-7 items-center pl-1.5 text-xs tabular-nums text-muted-foreground/70">
                  {meta}
                </span>
              ) : null}
              {hasSources ? (
                <button
                  type="button"
                  aria-expanded={currentSourcesOpen}
                  aria-controls={sourcesContentId}
                  onClick={() => setSourcesOpen(!currentSourcesOpen)}
                  // local patch (pi-app): text actions fill on hover too.
                  className="group ml-1 inline-flex min-h-7 items-center gap-2 rounded-md px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <CitationStack citations={sources} />
                  <span className="tabular-nums">
                    {sources.length} {sources.length === 1 ? "source" : "sources"}
                  </span>
                  <motion.span
                    aria-hidden="true"
                    animate={{ rotate: currentSourcesOpen ? 180 : 0 }}
                    transition={reduce ? { duration: 0 } : SPRING_SWAP}
                    className="text-muted-foreground/50 group-hover:text-muted-foreground"
                  >
                    <ChevronDown className="size-3" />
                  </motion.span>
                </button>
              ) : null}
            </div>

            {hasSources ? (
              <AgentDisclosure
                id={sourcesContentId}
                open={currentSourcesOpen}
              >
                <CitationList
                  citations={sources}
                  idPrefix={resolvedSourcePrefix}
                  className="mt-2 rounded-xl bg-muted p-2"
                />
              </AgentDisclosure>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
