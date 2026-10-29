import { useMemo, useState, type ReactNode } from 'react'
import { AgentCodeLine } from '@/components/agents/agent-code'
import { ToolResultOutput } from '@/components/agents/tool-result'
import { Button } from '@/components/motion/button'
import { useI18n } from '@/i18n'
import { useFileNavigation } from '@/lib/file-navigation'
import { fileLanguage } from '@/lib/file-language'
import { Folder } from '@/lib/icons'
import { basename } from '@/lib/format'
import { useFileSearch } from '@/lib/hooks/use-file-search'
import { useFileTokens } from '@/lib/hooks/use-file-tokens'
import { displayToolDir, resolveFromCwd } from '@/lib/tool-path'
import { grepOutputWindow, grepResultPath, grepSearchOptions, parseFileList, searchResultPath, splitReadOutput, toolOutputWindow, type GrepOutputLine } from '@/lib/tool-output'
import { cn } from '@/lib/utils'
import type { FileMatch } from '@/lib/file-search'
import type { ReadRangeDTO, ToolSearchRootDTO } from '../../../../shared/types'
import { FileTypeIcon } from './FileTypeIcon'

interface ToolFileOutputProps {
  tool: 'grep' | 'find' | 'ls' | 'read'
  text: string
  args: Record<string, unknown>
  cwd?: string | null
  root?: ToolSearchRootDTO
  range?: ReadRangeDTO
}

const FILE_ROW = 'flex h-auto min-h-[var(--app-line-code)] w-full items-center justify-start gap-2 rounded-inner px-1 py-0 font-mono text-code text-left font-normal'
const LINE_NUMBER = 'h-[var(--app-line-code)] shrink-0 justify-end rounded-inner px-1 py-0 font-mono text-code font-normal tabular-nums text-muted-foreground/60'

/** Paging stays inside the existing beUI output frame. Neither parsing nor
 * workers are mounted until the parent disclosure is opened. */
function useOutputWindow(text: string) {
  const [lineLimit, setLineLimit] = useState(100)
  const preview = useMemo(() => toolOutputWindow(text, lineLimit), [text, lineLimit])
  return { ...preview, showMore: () => setLineLimit(limit => limit + 100) }
}

function OutputContinuation({ hiddenLines, hardLimited, showMore }: Pick<ReturnType<typeof useOutputWindow>, 'hiddenLines' | 'hardLimited' | 'showMore'>) {
  const { t } = useI18n()
  return <>
    {hiddenLines > 0 && <Button variant="ghost" size="sm" className="mt-1 h-auto min-h-[var(--app-line-code)] px-1 py-0 text-xs" onClick={showMore}>
      {t('tool.outputShowMore', { count: hiddenLines })}
    </Button>}
    {hardLimited && <p className="mt-1 px-1 text-xs text-muted-foreground">{t('tool.outputPreviewLimit')}</p>}
  </>
}

function OutputNote({ children }: { children: string }) {
  return children ? <ToolResultOutput language="text" highlight={false} className="mt-1 px-1 text-muted-foreground">{children}</ToolResultOutput> : null
}

/** File names use the same artwork and navigation as the tree and rail tabs.
 * Directory rows remain labels, since the file-preview action reads files. */
function FileResultLabel({ displayPath, path, cwd, directory = false, annotation }: { displayPath: string; path?: string; cwd?: string | null; directory?: boolean; annotation?: string }) {
  const { t } = useI18n()
  const navigation = useFileNavigation()
  const dir = displayToolDir(displayPath.replace(/\/$/, ''), '.')
  const contents = <>
    {directory ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <FileTypeIcon path={displayPath} className="size-4 shrink-0" />}
    <span className="min-w-0 [overflow-wrap:anywhere]">
      <span className={cn('text-foreground', !directory && path && 'text-primary')}>{basename(displayPath.replace(/\/$/, ''))}{directory ? '/' : ''}</span>
      {dir && <span className="text-muted-foreground/60"> — {dir}</span>}
      {annotation && <span data-tool-search-annotation className="text-muted-foreground/60"> {annotation}</span>}
    </span>
  </>
  return !directory && path ? <Button variant="ghost" size="sm" className={FILE_ROW}
    data-file-link title={displayPath} aria-label={t('tool.openFile', { path: displayPath })}
    onClick={() => navigation.openPath(resolveFromCwd(path, cwd))}>{contents}</Button>
    : <div className={FILE_ROW}>{contents}</div>
}

function MatchText({ text, matches }: { text: string; matches?: FileMatch[] }) {
  if (!matches?.length) return <>{text}</>
  const parts: ReactNode[] = []
  let offset = 0
  for (const match of matches) {
    const start = match.column, end = start + match.end - match.start
    if (start < offset || end > text.length) continue
    if (start > offset) parts.push(text.slice(offset, start))
    parts.push(<mark key={start} data-tool-match className="rounded-detail bg-primary/20 text-foreground ring-1 ring-primary/40">{text.slice(start, end)}</mark>)
    offset = end
  }
  parts.push(text.slice(offset))
  return <>{parts}</>
}

function GrepOutput({ text, args, cwd, root }: ToolFileOutputProps) {
  const { t } = useI18n()
  const navigation = useFileNavigation()
  const [lineLimit, setLineLimit] = useState(100)
  const preview = useMemo(() => grepOutputWindow(text, lineLimit), [text, lineLimit])
  const blocks = preview.blocks
  const matchRows = useMemo(() => blocks.flatMap(block => block.kind === 'file' ? block.rows.filter(row => row.match) : []), [blocks])
  // Search only the returned source text, never path prefixes or context lines.
  // The shared disposable worker bounds regex execution and handles literals,
  // case folding and zero-width matches without blocking the renderer.
  const grouped = blocks.some(block => block.kind === 'file' && block.format === 'fff')
  const options = useMemo(() => grepSearchOptions(args, grouped), [args, grouped])
  const { result: matches } = useFileSearch(matchRows.map(row => row.text).join('\n'), typeof args.pattern === 'string' ? args.pattern : '', options, true)
  const byRow = useMemo(() => {
    const result = new Map<GrepOutputLine, FileMatch[]>()
    for (const match of matches.matches) {
      const row = matchRows[match.line - 1]
      if (row) {
        const ranges = result.get(row)
        if (ranges) ranges.push(match)
        else result.set(row, [match])
      }
    }
    return result
  }, [matches, matchRows])
  if (text === 'No matches found') return <ToolResultOutput language="text" highlight={false}>{t('tool.noMatches')}</ToolResultOutput>
  return <div data-tool-output="grep" className="font-mono text-code">
    {blocks.map((block, index) => {
      if (block.kind === 'text') return <OutputNote key={index}>{block.text}</OutputNote>
      const path = grepResultPath(block, args, cwd, root)
      const width = `${String(Math.max(...block.rows.map(row => row.line))).length + 1}ch`
      return <div key={index} data-tool-search-file={block.path} className={index > 0 ? 'mt-[var(--app-line-code)]' : undefined}>
        <FileResultLabel displayPath={block.path} path={path} cwd={cwd} annotation={block.annotation} />
        {block.rows.map((row, rowIndex) => <div key={rowIndex} data-tool-search-line={row.line} data-tool-search-match={row.match}
          className={cn('grid min-h-[var(--app-line-code)] grid-cols-[max-content_minmax(0,1fr)] rounded-none', row.match ? 'bg-primary/5 text-foreground/90' : 'text-muted-foreground/65')}>
          {path ? <Button variant="ghost" size="sm" className={LINE_NUMBER} style={{ minWidth: width }}
            aria-label={t('tool.openMatch', { path: block.path, line: row.line })} title={`${block.path}:${row.line}`}
            onClick={() => navigation.openPath(path, row.line)}>{row.line}</Button>
            : <span className={LINE_NUMBER} style={{ minWidth: width }}>{row.line}</span>}
          <pre className="m-0 min-w-0 whitespace-pre-wrap pr-1 font-mono text-code [overflow-wrap:anywhere]"><code>
            <MatchText text={row.text} matches={row.match ? byRow.get(row) : undefined} />
          </code></pre>
        </div>)}
      </div>
    })}
    <OutputContinuation {...preview} showMore={() => setLineLimit(limit => limit + 100)} />
  </div>
}

function FileListOutput({ tool, text, args, cwd, root }: ToolFileOutputProps) {
  const { t } = useI18n()
  const content = useMemo(() => parseFileList(text), [text])
  const preview = useOutputWindow(content.paths.join('\n'))
  if (text === 'No files found matching pattern' || text === '(empty directory)') return <ToolResultOutput language="text" highlight={false}>
    {t(tool === 'find' ? 'tool.noFiles' : 'tool.emptyDirectory')}
  </ToolResultOutput>
  return <div data-tool-output={tool} className="font-mono text-code">
    {preview.text.split('\n').filter(Boolean).map((path, index) => <FileResultLabel key={index} displayPath={path}
      path={searchResultPath(path, args, cwd, root)} cwd={cwd} directory={path.endsWith('/')} />)}
    <OutputNote>{content.note}</OutputNote>
    <OutputContinuation {...preview} />
  </div>
}

function ReadOutput({ text, args, cwd, range }: ToolFileOutputProps) {
  const { t } = useI18n()
  const navigation = useFileNavigation()
  const path = typeof args.path === 'string' ? args.path : ''
  const content = useMemo(() => splitReadOutput(text, range), [text, range])
  const preview = useOutputWindow(content.code)
  const tokens = useFileTokens(preview.text, fileLanguage(path))
  const numbered = range && Number.isSafeInteger(range.offset) && range.offset > 0 && Number.isSafeInteger(range.endLine) && range.endLine >= range.offset
  const width = `${String(range?.endLine ?? 1).length + 1}ch`
  return <div data-tool-output="read" className="font-mono text-code text-foreground/85">
    {preview.text.split('\n').map((line, index) => <div key={index} data-tool-read-line={numbered ? range.offset + index : undefined}
      className="grid min-h-[var(--app-line-code)] grid-cols-[max-content_minmax(0,1fr)]">
      {numbered && <Button variant="ghost" size="sm" className={LINE_NUMBER} style={{ minWidth: width }}
        aria-label={t('tool.openMatch', { path, line: range.offset + index })} title={`${path}:${range.offset + index}`}
        onClick={() => navigation.openPath(resolveFromCwd(path, cwd), range.offset + index)}>{range.offset + index}</Button>}
      <pre className={cn('m-0 min-w-0 whitespace-pre-wrap font-mono text-code [overflow-wrap:anywhere]', !numbered && 'col-span-2')}><code>
        <AgentCodeLine code={line} tokens={tokens?.[index]} />
      </code></pre>
    </div>)}
    <OutputNote>{content.note}</OutputNote>
    <OutputContinuation {...preview} />
  </div>
}

export function ToolFileOutput(props: ToolFileOutputProps) {
  switch (props.tool) {
    case 'grep': return <GrepOutput {...props} />
    case 'find': case 'ls': return <FileListOutput {...props} />
    case 'read': return <ReadOutput {...props} />
  }
}
