import { createContext, useContext, useMemo, useState } from 'react'
import { ArrowLeftFromLine, Minimize2 } from '@/lib/icons'
import { ToolResult } from '@/components/agents/tool-result'
import { Markdown } from '@/lib/markdown'
import { formatTokenCount } from '@/lib/format'
import { splitSummaryFiles } from '@/lib/summary-files'
import { useFileNavigation } from '@/lib/file-navigation'
import { useI18n } from '@/i18n'
import type { CompactionProcessDTO } from '../../../../shared/compaction'
import { CompactionProcessView } from './CompactionProcessView'

export type SummaryKind = 'compaction' | 'branch'
export type SummaryStatus = 'running' | 'success' | 'error' | 'cancelled'

/** A live row becomes a persisted row at settlement. Keep the user's disclosure
 * choice through that move, without mounting collapsed summary bodies. */
export const SummaryDisclosureContext = createContext<Map<string, boolean> | null>(null)

/**
 * A context rewrite reads as a tool row, because that is what it is: the app
 * (or the SDK between two rounds) runs one job over the conversation, the row
 * waits on it, and what comes back — the summary itself — is its result.
 *
 * Sharing the vendored `ToolResult` is what keeps it indistinguishable in
 * rhythm from the calls around it (36px trigger, glyph-led title, spinner →
 * check → x, the same disclosure), so a compaction inside a long turn reads as
 * one more step of that turn instead of a card interrupting it.
 *
 * The result body is the summary, mounted only while expanded (`lazyContent`)
 * and capped like every other tool body: a summary can be tens of thousands of
 * characters, and the row must cost nothing until the user asks for it.
 */
export function SummaryRow({ kind, status, summary, tokensBefore, detail, process }: {
  kind: SummaryKind
  status: SummaryStatus
  summary?: string
  /** Only a compaction records one; a branch summary covers an abandoned path. */
  tokensBefore?: number
  /** Raw failure detail; compaction shows it in the process region. */
  detail?: string
  process?: CompactionProcessDTO
}) {
  const { t } = useI18n()
  const disclosures = useContext(SummaryDisclosureContext)
  const [open, setOpen] = useState(() => status === 'error' || ((process && disclosures?.get(process.id)) ?? false))
  const changeOpen = (next: boolean): void => {
    setOpen(next)
    if (process && disclosures) {
      disclosures.set(process.id, next)
      if (disclosures.size > 128) disclosures.delete(disclosures.keys().next().value!)
    }
  }
  const Icon = kind === 'compaction' ? Minimize2 : ArrowLeftFromLine
  const meta = tokensBefore && tokensBefore > 0
    ? t('chat.summaryTokensBefore', { tokens: formatTokenCount(tokensBefore) })
    : undefined
  const { body, read, modified } = useMemo(() => splitSummaryFiles(summary ?? ''), [summary])
  // Only a settled summary carries the SDK's trailing file sections.
  const text = summary ? body : kind === 'branch' ? detail ?? '' : ''
  return (
    <div data-summary-row={kind} data-state={status}>
      <ToolResult
        animateChanges={false}
        lazyContent
        // Open failures on arrival so their process detail is visible.
        open={open}
        onOpenChange={changeOpen}
        collapseOnComplete={false}
        icon={<Icon aria-hidden="true" className="size-3.5" />}
        title={kind === 'compaction' ? t('chat.compactTitle') : t('chat.summaryBranchTitle')}
        meta={meta}
        status={status}
        maxHeight={320}
        header={kind === 'compaction' ? <CompactionProcessView process={process} detail={detail} /> : undefined}
      >
        {kind === 'compaction' ? <section data-compaction-summary aria-label={t('chat.compactionSummary')}>
          <h3 className="mb-2 text-xs font-medium text-foreground/80">{t('chat.compactionSummary')}</h3>
          {text ? <Markdown>{text}</Markdown> : <p className="text-xs text-muted-foreground">{t(
            status === 'running' ? 'chat.compactionSummaryPending' : status === 'cancelled' ? 'chat.compactionSummaryCancelled' : 'chat.compactionSummaryMissing'
          )}</p>}
          <SummaryFiles read={read} modified={modified} />
        </section> : <>
          {text ? <Markdown>{text}</Markdown> : null}
          <SummaryFiles read={read} modified={modified} />
        </>}
      </ToolResult>
    </div>
  )
}

/**
 * The summary's trailing file sections, as lists of the app's own file links.
 *
 * They are appended by the SDK for the model (`splitSummaryFiles`), so this is
 * the one place they become something a reader can scan and click: a bullet per
 * path, routed through `useFileNavigation` exactly like a markdown link, which
 * is what opens the file pane.
 */
function SummaryFiles({ read, modified }: { read: string[]; modified: string[] }) {
  const { t } = useI18n()
  if (!read.length && !modified.length) return null
  return (
    <div data-summary-files className="mt-3 flex flex-col gap-3">
      <SummaryFileGroup label={t('chat.summaryReadFiles')} paths={read} />
      <SummaryFileGroup label={t('chat.summaryModifiedFiles')} paths={modified} />
    </div>
  )
}

function SummaryFileGroup({ label, paths }: { label: string; paths: string[] }) {
  const navigation = useFileNavigation()
  if (!paths.length) return null
  return (
    <div data-summary-file-group>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <ul className="list-disc pl-5 text-sm leading-ui-loose">
        {paths.map((path) => (
          <li key={path} className="[overflow-wrap:anywhere]">
            <button
              type="button"
              data-file-link
              onClick={() => navigation.open(path)}
              className="cursor-pointer rounded-control px-1 text-left font-medium text-primary transition-colors hover:bg-primary/10"
            >
              {path}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
