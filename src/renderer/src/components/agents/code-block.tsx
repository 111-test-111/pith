// local patch (pi-app): shared scalable typography for UI annotations.
// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// beui.dev/components/agents/chat-app

// local patch (pi-app): use the shared UI icon adapter.
import { Check, Copy, FileCode2, WrapText } from "@/lib/icons";
import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
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
import { SPRING_PRESS } from "@/lib/ease";
import { cn } from "@/lib/utils";
// local patch (pi-app): clip only at whole code lines when the size changes.
import { codeLineHeight, useCodeFontSize } from "@/lib/typography";

type CodeBlockStatus = "streaming" | "complete";

export interface CodeBlockProps {
  code: string;
  language?: AgentCodeLanguage;
  filename?: ReactNode;
  status?: CodeBlockStatus;
  showLineNumbers?: boolean;
  highlightLines?: number[];
  maxHeight?: number;
  wrap?: boolean;
  // local patch (pi-app): app-owned headers can control the live wrap mode.
  onWrapChange?: (wrap: boolean) => void;
  copyable?: boolean;
  // local patch (pi-app): app compositions can own one shared header.
  showHeader?: boolean;
  onCopy?: () => void | Promise<void>;
  className?: string;
}

export function CodeBlock({
  code,
  language = "typescript",
  filename,
  status = "complete",
  showLineNumbers = true,
  highlightLines = [],
  maxHeight = 280,
  wrap = false,
  onWrapChange,
  copyable = true,
  showHeader = true,
  onCopy,
  className,
}: CodeBlockProps) {
  const reduce = useReducedMotion() ?? false;
  const rowHeight = codeLineHeight(useCodeFontSize());
  const viewportHeight = Math.max(rowHeight, Math.floor((maxHeight - 16) / rowHeight) * rowHeight) + 16;
  const viewportRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  // local patch (pi-app): preserve the standalone toggle while allowing a
  // shared app header to control wrapping without remounting the source.
  const [internalWrapped, setWrapped] = useState(wrap);
  const wrapped = onWrapChange ? wrap : internalWrapped;
  const streaming = status === "streaming";
  // local patch (pi-app): skip shiki while the block is still streaming —
  // lines render as plain text and get highlighted once on completion.
  const tokens = useAgentCodeTokens(code, language, status !== "streaming");
  const highlighted = useMemo(
    () => new Set(highlightLines),
    [highlightLines],
  );
  let offset = 0;
  const lines = code.split("\n").map((content) => {
    const line = { content, offset };
    offset += content.length + 1;
    return line;
  });
  const gutterWidth = `max(2.75rem, calc(${String(lines.length).length}ch + 1rem))`;

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !streaming) return;

    const frame = requestAnimationFrame(() => {
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: reduce ? "auto" : "smooth",
        });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy();
    else await navigator.clipboard?.writeText(code);

    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [code, onCopy]);

  return (
    <div
      data-state={status}
      aria-busy={streaming}
      className={cn(
        "w-full overflow-hidden rounded-2xl bg-muted/80 text-sm",
        className,
      )}
    >
      {showHeader ? <div className="flex h-10 items-center gap-2.5 px-3">
        <FileCode2
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground/70"
        />
        {filename ? (
          <span className="min-w-0 truncate font-mono text-xs text-foreground/80">
            {filename}
          </span>
        ) : null}
        <span className="text-micro font-medium uppercase tracking-wide text-muted-foreground/55">
          {language}
        </span>
        <motion.button
          type="button"
          aria-label="Wrap lines"
          aria-pressed={wrapped}
          title="Wrap lines"
          onClick={() => onWrapChange ? onWrapChange(!wrapped) : setWrapped(!wrapped)}
          transition={SPRING_PRESS}
          className={cn(
            "ml-auto grid size-7 shrink-0 place-items-center rounded-icon text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
            wrapped && "bg-background/70 text-foreground",
          )}
        >
          <WrapText className="size-3.5" />
        </motion.button>
        {copyable || onCopy ? (
          <motion.button
            type="button"
            aria-label={copied ? "Copied" : "Copy code"}
            title={copied ? "Copied" : "Copy code"}
            onClick={handleCopy}
            // local patch (pi-app): no press scale — a label icon button must not
            // dip inward while pressed (see `button/base`).
            transition={SPRING_PRESS}
            // local patch (pi-app): single-icon controls share the regular
            // control radius rather than a capsule (see rounded-icon).
            className="grid size-7 shrink-0 place-items-center rounded-icon text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </motion.button>
        ) : null}
      </div> : null}

      <div
        ref={viewportRef}
        role={streaming ? "log" : undefined}
        aria-live={streaming ? "polite" : undefined}
        className="scrollbar-hide overflow-auto border-t border-foreground/[0.06] py-2"
        style={{ maxHeight: viewportHeight }}
      >
        {/* local patch (pi-app): marked so StreamingResponse's raw-markdown
            `[&_pre]` framing skips this pre — CodeBlock frames itself. */}
        <pre
          data-code-block-pre=""
          className={cn(
            // local patch (pi-app): uncoloured code retains primary content contrast.
            "m-0 font-mono text-code text-foreground",
            // A wrapped block measures itself against the viewport; an
            // unwrapped one sizes to its longest line and scrolls sideways.
            !wrapped && "min-w-max",
          )}
        >
          <code>
            {lines.map((line, index) => {
              const lineNumber = index + 1;
              return (
                <span
                  key={line.offset}
                  className={cn(
                    "grid min-h-[var(--app-line-code)]",
                    !showLineNumbers && "grid-cols-1",
                    highlighted.has(lineNumber) && "bg-blue-500/[0.07]",
                  )}
                  style={showLineNumbers ? { gridTemplateColumns: `${gutterWidth} minmax(0,1fr)` } : undefined}
                >
                  {showLineNumbers ? (
                    <span className="select-none pr-3 text-right tabular-nums text-muted-foreground/35">
                      {lineNumber}
                    </span>
                  ) : null}
                  <AgentCodeLine
                    code={line.content}
                    tokens={tokens?.[index]}
                    className={cn(
                      "pr-4",
                      showLineNumbers ? "pl-1" : "pl-4",
                      wrapped ? "whitespace-pre-wrap break-words" : "whitespace-pre",
                    )}
                  />
                </span>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}
