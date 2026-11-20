import { useId, useMemo, useRef, useState } from 'react'
import { countDiffChanges, DIFF_HUNK_RANGE } from '@/lib/diff'
import { basename } from '@/lib/format'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { ReviewDiffBody, ReviewFileHeader } from './ReviewDiff'
import { DiffLayoutButton } from './DiffControls'
import type { DiffLayout } from '@/lib/diff-layout'

/**
 * Preview for a patch file (`.diff` / `.patch`): the raw text of a unified diff
 * rendered as the diff it describes, through the same body and file header the
 * Review pane and the Git-diff view use.
 *
 * The patch is split into its per-file sections here, because one `.patch`
 * usually describes several files and `parseUnifiedDiff` only follows hunks: fed
 * the whole text it would paint every file's lines as one anonymous stream.
 */

interface PatchSection {
  /** The path the section names, or `''` for a bare hunk stream. */
  path: string
  patch: string
  added: number
  removed: number
}

/** A hunk body line: context, added, removed, or the "\ No newline" marker. */
function isHunkBody(line: string): boolean {
  return line === '' || line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\')
}

/** The path a section's headers name, preferring the new side. `+++ /dev/null`
 * means the file was deleted, so the old side is the only real name then. */
function sectionPath(lines: string[], fallback: string): string {
  const strip = (line: string) => line.replace(/^(\+\+\+|\-\-\-)\s+/, '').split('\t')[0].trim()
  const stripPrefix = (path: string) => /^[ab]\//.test(path) ? path.slice(2) : path
  const plus = lines.find(line => line.startsWith('+++ '))
  if (plus) {
    const value = strip(plus)
    if (value && value !== '/dev/null') return stripPrefix(value)
  }
  const minus = lines.find(line => line.startsWith('--- '))
  if (minus) {
    const value = strip(minus)
    if (value && value !== '/dev/null') return stripPrefix(value)
  }
  const git = lines.find(line => line.startsWith('diff --git '))
  if (git) {
    const match = / b\/(.+)$/.exec(git)
    if (match) return match[1]
  }
  return fallback
}

/**
 * Split a patch into its file sections.
 *
 * A boundary is either git's own `diff --git` line or a `--- `/`+++ ` header
 * pair — the latter only OUTSIDE a hunk, because a removed line whose content
 * begins with `-- ` renders as a raw `--- ` line, and mistaking that for a new
 * file would cut a hunk in half.
 */
function splitPatch(text: string, fallback: string): PatchSection[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const groups: string[][] = []
  let current: string[] = []
  let inHunk = false
  let remaining = 0
  // Whether the group being built already began with git's own `diff --git`
  // line. Git announces one file with BOTH that line and a `--- `/`+++ ` pair,
  // so the pair is only a boundary for patches that have no git line —
  // otherwise every file would be counted twice.
  let announced = false
  const flush = () => { if (current.some(line => line !== '')) groups.push(current); current = []; announced = false }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (inHunk && (remaining === 0 || (!line.startsWith('@@') && !isHunkBody(line)))) inHunk = false
    const boundary = line.startsWith('diff --git ') || (!inHunk && !announced && line.startsWith('--- ') && (lines[index + 1] ?? '').startsWith('+++ '))
    if (boundary) flush()
    if (line.startsWith('diff --git ')) announced = true
    if (line.startsWith('@@')) {
      const range = DIFF_HUNK_RANGE.exec(line)
      // A bare patch may place its next file header right after the last row.
      remaining = range ? Number(range[2] ?? 1) + Number(range[4] ?? 1) : -1
      inHunk = true
    } else if (inHunk && remaining > 0) {
      if (line.startsWith(' ')) remaining = Math.max(0, remaining - 2)
      else if (line.startsWith('-') || line.startsWith('+')) remaining--
    }
    current.push(line)
  }
  flush()
  return groups.map(group => {
    const patch = group.join('\n')
    return { path: sectionPath(group, fallback), patch, ...countDiffChanges(patch) }
  })
}

export function FileDiffPreview({ text, displayPath, wrap, layout: sharedLayout, className }: {
  text: string; displayPath: string; wrap: boolean; layout?: DiffLayout; className?: string
}) {
  const { t } = useI18n()
  const scroll = useRef<HTMLDivElement>(null)
  const id = useId()
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set<number>())
  const [layouts, setLayouts] = useState<Record<number, DiffLayout>>({})
  const sections = useMemo(() => splitPatch(text, basename(displayPath)), [text, displayPath])
  const toggle = (index: number) => setCollapsed(previous => {
    const next = new Set(previous)
    if (!next.delete(index)) next.add(index)
    return next
  })

  if (sections.length === 0) return <div role="status" className="flex min-h-0 flex-1 items-center justify-center p-5 text-center text-xs leading-ui text-muted-foreground">{t('files.diffPreview.empty')}</div>
  return <div ref={scroll} data-file-diff-preview className={cn('min-h-0 flex-1 overflow-auto', className)}>
    {sections.map((section, index) => {
      const layout = sharedLayout ?? layouts[index] ?? 'stacked'
      const contentId = `${id}-${index}`
      return <section key={`${index}:${section.path}`} data-diff-file={section.path || undefined}>
        {section.path ? <ReviewFileHeader displayPath={section.path} collapsed={collapsed.has(index)} onToggle={() => toggle(index)}
          added={section.added} removed={section.removed} contentId={contentId}
          action={!sharedLayout && (section.added || section.removed) ? <DiffLayoutButton layout={layout} className="size-6"
            onChange={next => setLayouts(previous => ({ ...previous, [index]: next }))} /> : null} /> : null}
        {collapsed.has(index) ? null : <div id={contentId}>
          <ReviewDiffBody patch={section.patch} displayPath={section.path || displayPath} scrollRootRef={scroll} layoutKey={collapsed.size} wrap={wrap} layout={layout} />
        </div>}
      </section>
    })}
  </div>
}
