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
  Fragment,
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
  type AgentCodeToken,
  type AgentCodeTokenLines,
  AgentCodeLine,
  useAgentCodeTokens,
} from "@/components/agents/agent-code";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { useI18n } from "@/i18n";
import { SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";
// local patch (pi-app): bounded row DOM for the scrollable hover preview.
import { useDiffWindow } from "@/lib/hooks/use-diff-window";
// local patch (pi-app): row geometry follows the independent code preference.
import { codeLineHeight, useCodeFontSize } from "@/lib/typography";
// local patch (pi-app): shared hunk layout and word-level marks.
import { diffCodeText, diffGutterColumns, diffGutterWidth } from "@/lib/diff";
import { diffDisplayRows, diffLineWidths, diffRowsInWindow, reanchorDiffRow, type DiffLayout, type DiffLineWidths, type DiffRow, type DiffSide, type WrappedDiff } from "@/lib/diff-layout";
import { DiffWrapRuler, useDiffWrap } from "@/lib/hooks/use-diff-wrap";
import { diffInlineRanges, type DiffLinePair, type DiffRange } from "@/lib/diff-inline";
import { useDiffStyle } from "@/lib/diff-style";
import { sliceCodeTokens } from "@/lib/code-tokens";
// local patch (pi-app): the diff viewport's clipped edge fades instead of
// cutting a line (the app hides every scrollbar, so the cut had no other cue).
import { useScrollFade } from "@/lib/hooks/use-scroll-fade";
import { useWheelScroll } from "@/lib/hooks/use-wheel-scroll";

export type FileDiffStatus = "streaming" | "complete";
// local patch (pi-app): headings share the code row height and scroll window.
export type FileDiffLineType = "added" | "removed" | "context" | "hunk";

export interface FileDiffLine {
  id: string;
  type?: FileDiffLineType;
  oldLine?: number;
  newLine?: number;
  content: string;
  // local patch (pi-app): a wrapped continuation keeps the diff tint but has no marker.
  continuation?: boolean;
  pair?: DiffLinePair;
  sourceOffset?: number;
  source?: FileDiffLine;
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
  // local patch (pi-app): fit code to the available width in file and review panes.
  wrap?: boolean;
  // local patch (pi-app): app-owned layout action and externally windowed rows.
  layout?: DiffLayout;
  displayRows?: readonly DiffRow[];
  lineWidths?: DiffLineWidths;
  headerAction?: ReactNode;
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

// local patch (pi-app): mark exact ranges while retaining the code palette.
function DiffCode({ code, tokens, marks, className }: { code: string; tokens?: AgentCodeToken[]; marks?: readonly DiffRange[]; className: string }) {
  if (!marks?.length) return <AgentCodeLine code={code} tokens={tokens} className={className} />;
  const syntax = tokens?.map((token) => token.content).join("") === code ? tokens : undefined;
  const lineStart = syntax?.[0]?.offset ?? 0;
  const slice = (start: number, end: number) => start < end ? (
    <AgentCodeLine code={code.slice(start, end)} tokens={sliceCodeTokens(syntax, lineStart + start, lineStart + end)} />
  ) : null;

  return <span className={className}>
    {marks.map(({ start, end }, index) => <Fragment key={start}>
      {slice(marks[index - 1]?.end ?? 0, start)}
      <mark data-diff-inline="">{slice(start, end)}</mark>
    </Fragment>)}
    {slice(marks[marks.length - 1].end, code.length)}
  </span>;
}

export function FileDiff({
  file,
  lines: parsedLines,
  status = "streaming",
  open,
  defaultOpen = true,
  onOpenChange,
  collapseOnComplete = true,
  maxHeight = 220,
  wrap = true,
  layout = "stacked",
  displayRows,
  lineWidths,
  headerAction,
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
  const { t } = useI18n();
  const detailed = useDiffStyle() === "detailed";
  const split = layout === "side-by-side";
  const rows = useMemo(() => displayRows ?? diffDisplayRows(parsedLines, layout, detailed), [displayRows, parsedLines, layout, detailed]);
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
  const additions = additionsProp ?? parsedLines.filter((line) => line.type === "added").length;
  const deletions = deletionsProp ?? parsedLines.filter((line) => line.type === "removed").length;
  // local patch (pi-app): plain/pretokenized previews need no joined copy of a
  // large file on every scroll-window update.
  const code = useMemo(
    () => highlight && tokenLines === undefined ? diffCodeText(parsedLines) : "",
    [parsedLines, highlight, tokenLines],
  );
  // local patch (pi-app): Shiki and line DOM are deferred until the user
  // opens the diff, and never rerun for cumulative streaming snapshots.
  const liveTokens = useAgentCodeTokens(code, language, highlight && tokenLines === undefined && currentOpen && !streaming);
  const tokens = tokenLines === undefined ? liveTokens : tokenLines;
  const rowTokens = useMemo(() => {
    if (!tokens) return null;
    const byLine = new Map<FileDiffLine, AgentCodeToken[] | undefined>();
    let index = 0;
    for (const line of parsedLines) if (line.type !== "hunk") byLine.set(line, tokens[index++]);
    return byLine;
  }, [parsedLines, tokens]);
  // local patch (pi-app): reviews supply their own window. Settled standalone
  // previews window both their normal rows and their wrapped continuations.
  const virtual = virtualize && currentOpen && !streaming && maxHeightOverride !== null;
  const contained = containRows && !wrap;
  const widths = !wrap && (virtual || contained || split) ? lineWidths ?? diffLineWidths(parsedLines) : undefined;
  const rowHeight = codeLineHeight(useCodeFontSize());
  const gutterColumns = useMemo(() => gutterColumnsProp ?? diffGutterColumns(parsedLines), [gutterColumnsProp, parsedLines]);
  const gutterWidth = diffGutterWidth(gutterColumns);
  const measureWrap = virtual && wrap;
  const { ruler, wrapped, tabSize } = useDiffWrap(rows, measureWrap, layout, gutterWidth, rowHeight);
  const rowCount = wrapped?.rows ?? rows.length;
  const requestedHeight = maxHeightOverride === undefined ? maxHeight : maxHeightOverride;
  const viewportHeight = requestedHeight === null ? undefined : Math.max(rowHeight, Math.floor(requestedHeight / rowHeight) * rowHeight);
  const { start, end, onScroll } = useDiffWindow(viewportRef, rowCount, virtual, viewportHeight ?? maxHeight, rowHeight, false);
  const visible = useMemo(() => virtual ? diffRowsInWindow(rows, wrapped, start, end) : rows, [rows, wrapped, virtual, start, end]);
  const inlineRanges = useMemo(() => {
    if (!detailed || !currentOpen || streaming) return null;
    return diffInlineRanges(visible.flatMap(row => 'content' in row ? [row] : [row.before, row.after].filter(line => line !== undefined)));
  }, [detailed, currentOpen, streaming, visible]);
  useWheelScroll(viewportRef, currentOpen);

  const previousLayout = useRef<{ source: FileDiffLine[]; rows: readonly DiffRow[]; rowHeight: number; wrapped: WrappedDiff | null } | null>(null);
  const lastScrollTop = useRef(0);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !currentOpen || !virtual) { previousLayout.current = null; return; }
    const previous = previousLayout.current;
    if (lastScrollTop.current > 0 && previous?.source === parsedLines && (previous.rows !== rows || previous.wrapped !== wrapped || previous.rowHeight !== rowHeight)) {
      const next = reanchorDiffRow(lastScrollTop.current / previous.rowHeight, previous.rows, previous.wrapped, rows, wrapped);
      if (next !== undefined) viewport.scrollTop = next * rowHeight;
    }
    lastScrollTop.current = viewport.scrollTop;
    onScroll();
    previousLayout.current = { source: parsedLines, rows, rowHeight, wrapped };
  }, [currentOpen, onScroll, parsedLines, rowHeight, rows, virtual, wrapped]);

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

  const rowStyle: CSSProperties | undefined = virtual ? { height: rowHeight } : contained && !split ? {
    contentVisibility: "auto",
    containIntrinsicSize: `auto ${rowHeight}px`,
  } : undefined;
  const hasHeaderAction = !headerless && Boolean(headerAction);
  const renderLine = (line: FileDiffLine | undefined, key: string, side?: DiffSide) => {
    if (!line) return <div key={key} data-diff-blank="" aria-hidden="true" style={rowStyle} />;
    if (line.type === "hunk") {
      return side === "after" ? <div key={key} data-diff-hunk-spacer="" aria-hidden="true" />
        : <div key={key} data-diff-hunk="" title={line.content}><code>{line.content}</code></div>;
    }
    const type = line.type ?? "context";
    const syntax = rowTokens?.get(line.source ?? line);
    const tokenStart = (syntax?.[0]?.offset ?? 0) + (line.sourceOffset ?? 0);
    const lineTokens = line.source ? sliceCodeTokens(syntax, tokenStart, tokenStart + line.content.length) : syntax;
    return <div key={key} data-diff-change={type === "context" ? undefined : type} style={rowStyle}
      className={cn(
        "grid min-h-[var(--app-line-code)]",
        side ? "grid-cols-[var(--diff-gutter)_1rem_minmax(0,1fr)]" : "grid-cols-[var(--diff-gutter)_var(--diff-gutter)_1rem_minmax(0,1fr)]",
        type === "added" && "bg-emerald-500/[0.14]",
        type === "removed" && "bg-rose-500/[0.14]",
      )}>
      {side !== "after" ? <span className="select-none pr-2 text-right tabular-nums text-muted-foreground/40">{line.oldLine}</span> : null}
      {side !== "before" ? <span className="select-none pr-2 text-right tabular-nums text-muted-foreground/40">{line.newLine}</span> : null}
      <span className={cn("select-none text-center text-muted-foreground/45",
        type === "added" && "text-emerald-600 dark:text-emerald-400",
        type === "removed" && "text-rose-600 dark:text-rose-400",
      )}>
        {!line.continuation && (type === "added" ? "+" : type === "removed" ? "−" : "")}
      </span>
      <DiffCode code={line.content} tokens={lineTokens} marks={inlineRanges?.get(line)}
        className={cn("min-w-0 px-1.5", wrap ? "whitespace-break-spaces [overflow-wrap:anywhere]" : "whitespace-pre")} />
    </div>;
  };

  return (
    <div
      data-state={status}
      data-diff-layout={layout}
      aria-busy={streaming}
      className={cn("w-full text-sm", hasHeaderAction && "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1", className)}
    >
      {headerless ? null : (
        <>
        <button
          // local patch (pi-app): app-owned transcript geometry hook.
          data-agent-trigger=""
          id={triggerId}
          type="button"
          aria-expanded={currentOpen}
          aria-controls={contentId}
          onClick={() => setOpen(!currentOpen)}
          // local patch (pi-app): transcript disclosures stay unfilled on hover.
          className="group flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
          <span className="transcript-label min-w-0 truncate font-medium text-muted-foreground">
            {file}
          </span>
          {additions || deletions ? <span data-diff-counts className="flex shrink-0 items-center gap-2">
            <ChangeCount value={additions} type="added" />
            <ChangeCount value={deletions} type="removed" />
          </span> : null}
          <span className="ml-auto grid size-4 shrink-0 place-items-center text-muted-foreground/60">
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
        {headerAction}
        </>
      )}

      <AgentDisclosure
        // local patch (pi-app): only a real row body owns a leading gap.
        data-agent-body={!headerless || undefined}
        id={contentId}
        role={headerless ? undefined : "region"}
        aria-labelledby={headerless ? undefined : triggerId}
        className={hasHeaderAction ? 'col-span-2' : undefined}
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
              onScroll={virtual ? (event) => { lastScrollTop.current = event.currentTarget.scrollTop; onScroll(); } : undefined}
              className="relative scrollbar-hide overflow-auto"
              style={{
                maxHeight: viewportHeight,
                overflowAnchor: "none",
                maskImage,
                WebkitMaskImage: maskImage
              }}
            >
              {measureWrap ? <DiffWrapRuler ruler={ruler} layout={layout} gutter={gutterWidth} /> : null}
              {/* local patch (pi-app): the row wrapper is as wide as the widest
                  line (never narrower than the viewport), so a row's added/
                  removed tint spans the whole horizontally scrolled width
                  instead of stopping where the viewport ends. */}
              <div
                className={cn("min-w-full font-mono text-code", split || wrap ? "w-full" : "w-max")}
                style={{
                  '--diff-gutter': gutterWidth,
                  tabSize: wrapped ? tabSize : undefined,
                  width: !split && widths ? `calc(2 * var(--diff-gutter) + 2rem + ${Math.max(widths.before, widths.after)}ch)` : undefined,
                  // local patch (pi-app): spacers preserve the full scroll range
                  // without mounting the skipped rows; no estimated heights.
                  paddingTop: virtual ? start * rowHeight : undefined,
                  paddingBottom: virtual ? (rowCount - end) * rowHeight : undefined,
                } as CSSProperties}
              >
                <span className="sr-only">{t('diff.changes')}</span>
                {split && visible.length ? (
                  <div data-diff-split="" style={{ '--diff-split-rows': visible.length } as CSSProperties}>
                    {(['before', 'after'] as const).map(side => (
                      <div key={side} data-diff-side={side} role="region" aria-label={t(`diff.${side}`)} tabIndex={wrap ? undefined : 0}
                        style={widths ? { '--diff-side-width': widths[side] ? `calc(var(--diff-gutter) + 2rem + ${widths[side]}ch)` : undefined } as CSSProperties : undefined}
                        className="outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
                        {visible.map(row => renderLine('content' in row ? row : row[side], row.id, side))}
                      </div>
                    ))}
                  </div>
                ) : visible.map(row => 'content' in row ? renderLine(row, row.id) : null)}
              </div>
            </div>
          </div>
        )}
      </AgentDisclosure>
    </div>
  );
}
