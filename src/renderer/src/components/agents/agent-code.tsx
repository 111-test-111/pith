// local patch (pi-app): shared scalable typography for content and code.
"use client";

import {
  type CSSProperties,
  Fragment,
  useEffect,
  useState,
} from "react";
import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";
import { cn } from "@/lib/utils";
// local patch (pi-app): all code surfaces share the persisted theme pair.
import { getCodeThemes, useCodeThemes } from "@/lib/code-theme-settings";
import { codeThemeKey, codeTokenCacheKey, type CodeThemes } from "@/lib/code-themes";

// local patch (pi-app): file previews use Shiki's full language set, loaded on
// demand. Existing transcript consumers retain the same initial grammars.
export type AgentCodeLanguage = BundledLanguage | "text";

export interface AgentCodeToken {
  content: string;
  offset: number;
  light?: string;
  dark?: string;
}

export type AgentCodeTokenLines = AgentCodeToken[][];

export interface AgentCodeProps {
  code: string;
  language?: AgentCodeLanguage;
  /** local patch (pi-app): disable Shiki for cumulative live tool output. */
  highlight?: boolean;
  className?: string;
}

export interface AgentCodeLineProps {
  code: string;
  tokens?: AgentCodeToken[];
  className?: string;
}

let agentCodeHighlighter: Promise<Highlighter> | null = null;
const tokenCache = new Map<string, AgentCodeTokenLines>();
// local patch (pi-app): in-flight tokenizations, so a hover prefetch and the
// panel that mounts moments later never tokenize the same code twice.
const tokenPending = new Map<string, Promise<AgentCodeTokenLines>>();
// local patch (pi-app): bound the cache — completed code is what gets
// re-rendered; intermediate snapshots were never re-read but accumulated.
const TOKEN_CACHE_MAX = 400;

function getAgentCodeHighlighter() {
  if (!agentCodeHighlighter) {
    agentCodeHighlighter = createHighlighter({
      // local patch (pi-app): load the selected pair on demand below.
      themes: [],
      langs: ["bash", "diff", "json", "tsx", "typescript"],
    });
  }
  return agentCodeHighlighter;
}

/**
 * Tokenizes `code` into the cache, deduped across concurrent callers.
 *
 * local patch (pi-app): shared by the hook below and `prefetchAgentCodeTokens`,
 * so a panel mounting while its prefetch is still running waits on the same
 * promise instead of starting a second (tens of ms) tokenization.
 */
function ensureAgentCodeTokens(
  code: string,
  language: AgentCodeLanguage,
  themes: CodeThemes,
): Promise<AgentCodeTokenLines> {
  const key = codeTokenCacheKey(code, language, themes);
  const cached = tokenCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = tokenPending.get(key);
  if (pending) return pending;

  const promise = getAgentCodeHighlighter()
    .then(async (highlighter) => {
      const already = tokenCache.get(key);
      if (already) return already;
      // local patch (pi-app): markdown/source files need their own grammars.
      if (language !== "text" && !highlighter.getLoadedLanguages().includes(language)) {
        await highlighter.loadLanguage(language);
      }
      // local patch (pi-app): requests retain their theme snapshot across awaits;
      // a late result cannot overwrite a newly selected palette's cache entry.
      const missingThemes = [themes.light, themes.dark].filter(theme => !highlighter.getLoadedThemes().includes(theme));
      if (missingThemes.length) await highlighter.loadTheme(...missingThemes);
      const lines = highlighter
        .codeToTokensWithThemes(code, {
          lang: language,
          themes: { ...themes },
        })
        .map((line) =>
          line.map((token) => ({
            content: token.content,
            offset: token.offset,
            light: token.variants.light?.color,
            dark: token.variants.dark?.color,
          })),
        );
      if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
      tokenCache.set(key, lines);
      return lines;
    })
    // local patch (pi-app): a missing grammar/chunk must leave readable text,
    // never an unhandled rejection in a file or transcript preview.
    .catch(() => [] as AgentCodeTokenLines)
    .finally(() => {
      tokenPending.delete(key);
    });
  tokenPending.set(key, promise);
  return promise;
}

/**
 * local patch (pi-app): warm the token cache from outside React.
 *
 * The turn's file rows prefetch their diffs while the pointer is on the list, so
 * hovering one mounts the panel already highlighted — otherwise the tokens land
 * tens of ms later and repaint the whole diff a second time, which shows up as a
 * hitch on every hover hand-over.
 */
export function prefetchAgentCodeTokens(
  code: string,
  language: AgentCodeLanguage,
): Promise<void> {
  return ensureAgentCodeTokens(code, language, getCodeThemes()).then(() => undefined);
}

// local patch (pi-app): previews snapshot already-warm tokens on entry. A cold
// preview stays plain for that visit instead of repainting after Shiki lands.
export function getCachedAgentCodeTokens(code: string, language: AgentCodeLanguage, themes = getCodeThemes()) {
  return tokenCache.get(codeTokenCacheKey(code, language, themes));
}

export function useAgentCodeTokens(
  code: string,
  language: AgentCodeLanguage,
  // local patch (pi-app): `enabled: false` (code still streaming) skips shiki
  // entirely — re-highlighting the full growing block per delta was quadratic
  // CPU. Highlighting runs once when the block completes.
  enabled = true,
) {
  // local patch (pi-app): update mounted blocks when Appearance changes.
  const [themes] = useCodeThemes();
  const themeKey = codeThemeKey(themes);
  const key = enabled ? codeTokenCacheKey(code, language, themes) : "";
  const cached = enabled ? tokenCache.get(key) : undefined;
  const [result, setResult] = useState<{
    key: string;
    code: string;
    language: AgentCodeLanguage;
    themeKey: string;
    lines: AgentCodeTokenLines;
  } | null>(cached ? { key, code, language, themeKey, lines: cached } : null);

  useEffect(() => {
    if (!enabled) return;
    const current = tokenCache.get(key);
    if (current) {
      setResult({ key, code, language, themeKey, lines: current });
      return;
    }

    let cancelled = false;
    ensureAgentCodeTokens(code, language, themes).then((lines) => {
      if (cancelled) return;
      setResult({ key, code, language, themeKey, lines });
    });
    return () => {
      cancelled = true;
    };
  }, [code, key, language, enabled, themes, themeKey]);

  if (!enabled) return null;
  if (result?.key === key) return result.lines;
  if (result?.themeKey === themeKey && result.language === language && code.startsWith(result.code)) {
    return result.lines;
  }
  return null;
}

export function AgentCodeLine({
  code,
  tokens,
  className,
}: AgentCodeLineProps) {
  return (
    <span className={className}>
      {tokens
        ? tokens.map((token) => (
            <span
              key={`${token.offset}-${token.content}`}
              // local patch (pi-app): paired previews pin a token's color mode.
              data-agent-code-token=""
              style={
                {
                  "--agent-code-light": token.light ?? "currentColor",
                  "--agent-code-dark": token.dark ?? token.light ?? "currentColor",
                } as CSSProperties
              }
              className="text-[var(--agent-code-light)] dark:text-[var(--agent-code-dark)]"
            >
              {token.content}
            </span>
          ))
        : code}
    </span>
  );
}

export function AgentCode({
  code,
  language = "bash",
  highlight = true,
  className,
}: AgentCodeProps) {
  // local patch (pi-app): highlighting a growing terminal snapshot on every
  // tool update is quadratic; callers enable it after completion.
  const tokens = useAgentCodeTokens(code, language, highlight);
  let offset = 0;
  const lines = code.split("\n").map((content) => {
    const line = { content, offset };
    offset += content.length + 1;
    return line;
  });

  return (
    <pre
      className={cn(
        // local patch (pi-app): uncoloured code retains primary content contrast.
        "m-0 overflow-x-auto whitespace-pre font-mono text-code text-foreground",
        className,
      )}
    >
      <code>
        {lines.map((line, index) => (
          <Fragment key={line.offset}>
            <AgentCodeLine code={line.content} tokens={tokens?.[index]} />
            {index < lines.length - 1 ? "\n" : null}
          </Fragment>
        ))}
      </code>
    </pre>
  );
}
