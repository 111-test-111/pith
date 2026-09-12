"use client";
// beui.dev/components/agents/chat-app

import {
  Check,
  ChevronDown,
  Copy,
  FileCode2,
  LoaderCircle,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AgentCodeLanguage,
  AgentCodeLine,
  useAgentCodeTokens,
} from "@/components/agents/agent-code";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { SPRING_PRESS, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type FileDiffStatus = "streaming" | "complete";
export type FileDiffLineType = "added" | "removed" | "context";

export interface FileDiffLine {
  id: string;
  type?: FileDiffLineType;
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface FileDiffProps {
  file: ReactNode;
  lines: FileDiffLine[];
  status?: FileDiffStatus;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapseOnComplete?: boolean;
  maxHeight?: number;
  language?: AgentCodeLanguage;
  copyText?: string;
  onCopy?: () => void | Promise<void>;
  /** local patch (pi-app): glyph for the row; the app maps tool names to icons
   * (edit vs write) and falls back to the vendored FileCode2 when omitted. */
  icon?: ReactNode;
  /** local patch (pi-app): precomputed +/- counts shown in the header while
   * `lazyContent` defers the parsed `lines`. */
  additions?: number;
  deletions?: number;
  /** local patch (pi-app): do not mount/highlight diff rows while collapsed. */
  lazyContent?: boolean;
  /** local patch (pi-app): render the diff body without its disclosure header,
   * for hosts that supply their own chrome (the turn's written-files hover
   * preview) — the body also drops the header's indent so it fills the panel. */
  headerless?: boolean;
  /** local patch (pi-app): skip Shiki for this diff. The preview panel turns it
   * off: highlighting a few hundred rows lands ~10-95ms AFTER the panel mounts,
   * which reads as the content settling twice on every hover hand-over. */
  highlight?: boolean;
  /** local patch (pi-app): skip layout/paint of rows outside the diff's own
   * scrollport. A long `write` diff is thousands of rows, and measuring them all
   * on every hover-preview mount made switching files stutter; the intrinsic
   * size keeps the scroll height right without laying each row out. Only the
   * preview turns this on — the transcript's diff keeps full fidelity. */
  containRows?: boolean;
  className?: string;
}

function ChangeCount({ value, type }: { value: number; type: "added" | "removed" }) {
  if (!value) return null;
  return (
    <span
      className={cn(
        "font-mono text-xs tabular-nums",
        type === "added"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-rose-600 dark:text-rose-400",
      )}
    >
      {type === "added" ? "+" : "−"}
      {value}
    </span>
  );
}

export function FileDiff({
  file,
  lines,
  status = "streaming",
  open,
  defaultOpen = true,
  onOpenChange,
  collapseOnComplete = true,
  maxHeight = 220,
  language = "typescript",
  copyText,
  onCopy,
  icon,
  headerless = false,
  highlight = true,
  lazyContent = false,
  containRows = false,
  additions: additionsProp,
  deletions: deletionsProp,
  className,
}: FileDiffProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef(status);
  const copyTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = open ?? internalOpen;
  const streaming = status === "streaming";
  const additions = additionsProp ?? lines.filter((line) => line.type === "added").length;
  const deletions = deletionsProp ?? lines.filter((line) => line.type === "removed").length;
  const canCopy = Boolean(copyText || onCopy);
  const code = lines.map((line) => line.content).join("\n");
  // local patch (pi-app): the widest row, so `containRows` can lay the body out
  // at a fixed width instead of measuring it from `w-max` — with rows skipped by
  // `content-visibility`, `w-max` only sees the rows that happen to be rendered,
  // which would cut horizontal scrolling short. The diff is monospace, so the
  // widest line in `ch` is exact.
  const widestLine = useMemo(
    () => lines.reduce((widest, line) => Math.max(widest, line.content.length), 0),
    [lines],
  );
  // local patch (pi-app): Shiki and line DOM are deferred until the user
  // opens the diff, and never rerun for cumulative streaming snapshots.
  const tokens = useAgentCodeTokens(code, language, highlight && currentOpen && !streaming);

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, open],
  );

  useEffect(() => {
    if (previousStatus.current !== "streaming" && status === "streaming") {
      setOpen(true);
    }
    if (
      previousStatus.current === "streaming" &&
      status === "complete" &&
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
    if (!viewport || !currentOpen || !streaming) return;

    const frame = requestAnimationFrame(() => {
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          // local patch (pi-app): avoid restarting a smooth scroll for every
          // cumulative diff update while an expanded edit is streaming.
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
      aria-busy={streaming}
      className={cn("w-full text-sm", className)}
    >
      {headerless ? null : (
        <button
          id={triggerId}
          type="button"
          aria-expanded={currentOpen}
          aria-controls={contentId}
          onClick={() => setOpen(!currentOpen)}
          className="group flex min-h-9 w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {icon ?? (
            <FileCode2
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
          )}
          {/* local patch (pi-app): the app's tool rows are prose labels
              (`edit · file — path`), not code, so they use the same UI font,
              size and muted chrome color as the ToolResult title. */}
          <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground">
            {file}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <ChangeCount value={additions} type="added" />
            <ChangeCount value={deletions} type="removed" />
          </span>
          <span className="grid size-4 shrink-0 place-items-center text-muted-foreground/60">
            {streaming ? (
              <LoaderCircle
                aria-label="Applying changes"
                className={cn("size-3.5", !reduce && "animate-spin")}
              />
            ) : (
              <Check aria-label="Changes applied" className="size-3.5" />
            )}
          </span>
          <motion.span
            aria-hidden="true"
            animate={{ rotate: currentOpen ? 180 : 0 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="shrink-0 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground"
          >
            <ChevronDown className="size-3.5" />
          </motion.span>
        </button>
      )}

      <AgentDisclosure
        id={contentId}
        role={headerless ? undefined : "region"}
        aria-labelledby={headerless ? undefined : triggerId}
        open={currentOpen}
      >
        {lazyContent && !currentOpen ? null : (
          <div
            className={cn(
              "overflow-hidden rounded-xl bg-muted/80",
              // local patch (pi-app): a headerless body is the panel, not a row
              // indented under its own disclosure header.
              !headerless && "ml-6 mt-1.5",
            )}
          >
            <div
              ref={viewportRef}
              data-slot="file-diff-viewport"
              aria-live="polite"
              className="scrollbar-hide overflow-auto"
              style={{ maxHeight }}
            >
              {/* local patch (pi-app): the row wrapper is as wide as the widest
                  line (never narrower than the viewport), so a row's added/
                  removed tint spans the whole horizontally scrolled width
                  instead of stopping where the viewport ends. */}
              <div
                className="w-max min-w-full font-mono text-xs leading-5"
                style={containRows ? { width: `calc(6.5rem + ${widestLine}ch)` } : undefined}
              >
                <span className="sr-only">File changes</span>
                {lines.map((line, index) => {
                  const type = line.type ?? "context";
                  return (
                    <div
                      key={line.id}
                      style={
                        containRows
                          ? {
                              contentVisibility: "auto",
                              containIntrinsicSize: "auto 20px",
                            }
                          : undefined
                      }
                      className={cn(
                        "grid grid-cols-[2.25rem_2.25rem_1rem_minmax(0,1fr)]",
                        type === "added" && "bg-emerald-500/[0.07]",
                        type === "removed" && "bg-rose-500/[0.07]",
                      )}
                    >
                      <span className="select-none pr-2 text-right tabular-nums text-muted-foreground/40">
                        {line.oldLine}
                      </span>
                      <span className="select-none pr-2 text-right tabular-nums text-muted-foreground/40">
                        {line.newLine}
                      </span>
                      <span
                        className={cn(
                          "select-none text-center text-muted-foreground/45",
                          type === "added" &&
                            "text-emerald-600 dark:text-emerald-400",
                          type === "removed" &&
                            "text-rose-600 dark:text-rose-400",
                        )}
                      >
                        {type === "added"
                          ? "+"
                          : type === "removed"
                            ? "−"
                            : ""}
                      </span>
                      <AgentCodeLine
                        code={line.content}
                        tokens={tokens?.[index]}
                        className="min-w-0 whitespace-pre px-1.5"
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {canCopy ? (
              <div className="flex justify-end px-2 pb-1.5 pt-1">
                <motion.button
                  type="button"
                  aria-label={copied ? "Copied" : "Copy diff"}
                  title={copied ? "Copied" : "Copy diff"}
                  onClick={handleCopy}
                  whileTap={reduce ? undefined : { scale: 0.9 }}
                  transition={SPRING_PRESS}
                  className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {copied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </motion.button>
              </div>
            ) : null}
          </div>
        )}
      </AgentDisclosure>
    </div>
  );
}
