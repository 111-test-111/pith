// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// beui.dev/components/agents/chat-app

// local patch (pi-app): use the shared UI icon adapter.
import {
  Check,
  ChevronDown,
  FileCode2,
  LoaderCircle,
} from "@/lib/icons";
import { motion, useReducedMotion } from "motion/react";
import {
  type CSSProperties,
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
  type AgentCodeTokenLines,
  AgentCodeLine,
  useAgentCodeTokens,
} from "@/components/agents/agent-code";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";
// local patch (pi-app): bounded row DOM for the scrollable hover preview.
import { useDiffWindow } from "@/lib/hooks/use-diff-window";
// local patch (pi-app): row geometry follows the independent code preference.
import { codeLineHeight, useCodeFontSize } from "@/lib/typography";
import { diffGutterColumns } from "@/lib/diff";
// local patch (pi-app): the diff viewport's clipped edge fades instead of
// cutting a line (the app hides every scrollbar, so the cut had no other cue).
import { useScrollFade } from "@/lib/hooks/use-scroll-fade";

export type FileDiffStatus = "streaming" | "complete";
export type FileDiffLineType = "added" | "removed" | "context";

export interface FileDiffLine {
  id: string;
  type?: FileDiffLineType;
  oldLine?: number;
  newLine?: number;
  content: string;
}

// local patch (pi-app): a hover preview reuses its parsed line array across
// visits. Cache its width with that array so remounting the small virtual window
// does not rescan every line of a large patch.
const widestLineCache = new WeakMap<FileDiffLine[], number>();

export interface FileDiffProps {
  file: ReactNode;
  lines: FileDiffLine[];
  status?: FileDiffStatus;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapseOnComplete?: boolean;
  maxHeight?: number;
  /** local patch (pi-app): keep gutters stable across a parent-owned window. */
  gutterColumns?: number;
  language?: AgentCodeLanguage;
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
  /** local patch (pi-app): `null` removes the body's height cap, so the diff
   * grows with the page and one scrollbar (with sticky file headers) drives the
   * whole view — the review tab's case — instead of a scroll region per file. */
  maxHeightOverride?: number | null;
  /** local patch (pi-app): keep the clipped-edge ramp. The written-files hover
   * preview clears it: inside its shadowed popover the extra edge fade read as a
   * shadow gradient over the code. */
  edgeFade?: boolean;
  /** local patch (pi-app): classes for the body's own frame. The review tab
   * squares its corners (`rounded-none`) so the diff sits flush under the file
   * header it belongs to; the vendored default is a rounded card. */
  bodyClassName?: string;
  /** local patch (pi-app): skip Shiki for this diff. The preview panel turns it
   * off: highlighting a few hundred rows lands ~10-95ms AFTER the panel mounts,
   * which reads as the content settling twice on every hover hand-over. */
  highlight?: boolean;
  // local patch (pi-app): the preview snapshots prewarmed tokens, avoiding an
  // asynchronous plain-to-coloured repaint while the pointer switches files.
  tokenLines?: AgentCodeTokenLines | null;
  // local patch (pi-app): only mount visible rows plus overscan in a bounded
  // preview. Unlike containRows, DOM creation is independent of file length.
  virtualize?: boolean;
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
  gutterColumns: gutterColumnsProp,
  maxHeightOverride,
  bodyClassName,
  edgeFade = true,
  language = "typescript",
  icon,
  headerless = false,
  highlight = true,
  tokenLines,
  virtualize = false,
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
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = open ?? internalOpen;
  // local patch (pi-app): a mask on whichever end of the cap hides rows. A
  // Review body (`maxHeightOverride={null}`) never overflows, so it keeps none,
  // and the body is lazy, so the measurement follows the disclosure's state.
  const { edges: fadeEdges, maskImage: fadeMaskImage } = useScrollFade(viewportRef, { dependsOn: currentOpen });
  // local patch (pi-app): a host may opt out of the clipped-edge ramp.
  const maskImage = edgeFade ? fadeMaskImage : undefined;
  const fade = !edgeFade ? "none" : fadeEdges.top && fadeEdges.bottom ? "both" : fadeEdges.bottom ? "bottom" : fadeEdges.top ? "top" : "none";
  const streaming = status === "streaming";
  const additions = additionsProp ?? lines.filter((line) => line.type === "added").length;
  const deletions = deletionsProp ?? lines.filter((line) => line.type === "removed").length;
  // local patch (pi-app): plain/pretokenized previews need no joined copy of a
  // large file on every scroll-window update.
  const code = useMemo(
    () => highlight && tokenLines === undefined ? lines.map((line) => line.content).join("\n") : "",
    [lines, highlight, tokenLines],
  );
  // local patch (pi-app): the widest row, so `containRows` can lay the body out
  // at a fixed width instead of measuring it from `w-max` — with rows skipped by
  // `content-visibility`, `w-max` only sees the rows that happen to be rendered,
  // which would cut horizontal scrolling short. Tabs and Unicode use a
  // conservative column bound, while ASCII monospace columns are exact.
  const widestLine = useMemo(() => {
    const cached = widestLineCache.get(lines);
    if (cached !== undefined) return cached;
    const width = lines.reduce((widest, line) => {
      // local patch (pi-app): tabs and wide Unicode must not truncate horizontal
      // scrolling when the widest line is outside the mounted window. Use a
      // conservative column bound for non-ASCII glyphs (including CJK fonts).
      if (!/[\t\u0080-\uFFFF]/.test(line.content)) return Math.max(widest, line.content.length);
      let columns = 0;
      for (const character of line.content) {
        if (character === "\t") columns += 8 - columns % 8;
        else columns += character.codePointAt(0)! > 127 ? 2 : 1;
      }
      return Math.max(widest, columns);
    }, 0);
    widestLineCache.set(lines, width);
    return width;
  }, [lines]);
  // local patch (pi-app): Shiki and line DOM are deferred until the user
  // opens the diff, and never rerun for cumulative streaming snapshots.
  const liveTokens = useAgentCodeTokens(code, language, highlight && tokenLines === undefined && currentOpen && !streaming);
  const tokens = tokenLines === undefined ? liveTokens : tokenLines;
  // local patch (pi-app): uncapped reviews and growing transcript diffs retain
  // their complete DOM. Opt-in settled previews have non-wrapping code
  // rows and keep only the visible window mounted.
  const virtual = virtualize && !streaming && maxHeightOverride !== null;
  const rowHeight = codeLineHeight(useCodeFontSize());
  const gutterColumns = useMemo(() => gutterColumnsProp ?? diffGutterColumns(lines), [gutterColumnsProp, lines]);
  const requestedHeight = maxHeightOverride === undefined ? maxHeight : maxHeightOverride;
  const viewportHeight = requestedHeight === null ? undefined : Math.max(rowHeight, Math.floor(requestedHeight / rowHeight) * rowHeight);
  const { start, end, onScroll } = useDiffWindow(viewportRef, lines.length, virtual, viewportHeight ?? maxHeight, rowHeight);

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

  return (
    <div
      data-state={status}
      aria-busy={streaming}
      className={cn("w-full text-sm", className)}
    >
      {headerless ? null : (
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
          {icon ?? (
            <FileCode2
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
          )}
          {/* local patch (pi-app): the app's tool rows are prose labels
              (`edit · file — path`), not code, so they use the same UI font,
              size and muted chrome color as the ToolResult title. */}
          {/* local patch (pi-app): share tool/reasoning label type alignment. */}
          <span className="transcript-label min-w-0 flex-1 truncate font-medium text-muted-foreground">
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
        // local patch (pi-app): only a real row body owns a leading gap.
        data-agent-body={!headerless || undefined}
        id={contentId}
        role={headerless ? undefined : "region"}
        aria-labelledby={headerless ? undefined : triggerId}
        open={currentOpen}
      >
        {lazyContent && !currentOpen ? null : (
          <div
            data-diff-body=""
            className={cn(
              "overflow-hidden rounded-xl bg-muted/80",
              bodyClassName,
              // local patch (pi-app): a headerless body is the panel, not a row
              // indented under its own disclosure header.
              !headerless && "ml-6 mt-1.5",
            )}
          >
            <div
              ref={viewportRef}
              data-slot="file-diff-viewport"
              data-fade={fade}
              // Settled virtual windows replace their visible row subtree on
              // scroll; announcing that as live output makes screen readers
              // repeat the diff. Only a genuinely growing diff is live.
              aria-live={streaming ? "polite" : undefined}
              onScroll={virtual ? onScroll : undefined}
              className="scrollbar-hide overflow-auto"
              style={{
                maxHeight: viewportHeight,
                overflowAnchor: "none",
                maskImage,
                WebkitMaskImage: maskImage
              }}
            >
              {/* local patch (pi-app): the row wrapper is as wide as the widest
                  line (never narrower than the viewport), so a row's added/
                  removed tint spans the whole horizontally scrolled width
                  instead of stopping where the viewport ends. */}
              <div
                className="w-max min-w-full font-mono text-code"
                style={{
                  '--diff-gutter': `max(2.25rem, calc(${gutterColumns}ch + 0.5rem))`,
                  width: containRows || virtual ? `calc(2 * var(--diff-gutter) + 2rem + ${widestLine}ch)` : undefined,
                  // local patch (pi-app): spacers preserve the full scroll range
                  // without mounting the skipped rows; no estimated heights.
                  paddingTop: virtual ? start * rowHeight : undefined,
                  paddingBottom: virtual ? (lines.length - end) * rowHeight : undefined,
                } as CSSProperties}
              >
                <span className="sr-only">File changes</span>
                {(virtual ? lines.slice(start, end) : lines).map((line, offset) => {
                  const index = start + offset;
                  const type = line.type ?? "context";
                  return (
                    <div
                      key={line.id}
                      style={
                        virtual
                          ? { height: rowHeight }
                          : containRows
                          ? {
                              contentVisibility: "auto",
                              containIntrinsicSize: `auto ${rowHeight}px`,
                            }
                          : undefined
                      }
                      className={cn(
                        "grid grid-cols-[var(--diff-gutter)_var(--diff-gutter)_1rem_minmax(0,1fr)]",
                        // local patch (pi-app): the vendored 7% wash was too pale
                        // to read as a change on the muted panel — the owner
                        // asked for deeper diff colours everywhere FileDiff
                        // renders (tool rows, review, checkpoints, previews).
                        type === "added" && "bg-emerald-500/[0.14]",
                        type === "removed" && "bg-rose-500/[0.14]",
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
          </div>
        )}
      </AgentDisclosure>
    </div>
  );
}
