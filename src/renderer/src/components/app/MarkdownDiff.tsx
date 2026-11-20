import { useMemo, useState } from 'react'
import { CodeBlock } from '@/components/agents/code-block'
import { useI18n } from '@/i18n'
import { countDiffChanges } from '@/lib/diff'
import type { DiffLayout } from '@/lib/diff-layout'
import { DiffLayoutButton } from './DiffControls'
import { FileDiffPreview } from './FileDiffPreview'

export function MarkdownDiff({ code, streaming }: { code: string; streaming: boolean }) {
  const { t } = useI18n()
  const [layout, setLayout] = useState<DiffLayout>('stacked')
  const [wrap, setWrap] = useState(true)
  const { added, removed } = useMemo(() => countDiffChanges(code), [code])
  const canCompare = added + removed > 0
  return <CodeBlock code={code} language="diff" status={streaming ? 'streaming' : 'complete'} wrap={wrap} onWrapChange={setWrap} wrapLabel={t('files.wrap')}
    headerAction={canCompare ? <DiffLayoutButton layout={layout} onChange={setLayout} /> : null}
    body={canCompare && layout === 'side-by-side'
      ? <FileDiffPreview text={code} displayPath="" wrap={wrap} layout={layout} className="max-h-[280px] border-t border-foreground/[0.06]" />
      : undefined} />
}
