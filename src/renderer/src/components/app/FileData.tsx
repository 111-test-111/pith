import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { useI18n } from '@/i18n'
import { useBinaryPreview } from '@/lib/hooks/use-binary-preview'
import { useDataPreview } from '@/lib/hooks/use-data-preview'
import type { DataIndex } from '../../../../shared/file-preview'
import type { FileBrowserStore, FileTab } from '@/state/file-browser-store'
import { FileTableGrid } from './FileTable'
import { FilePreviewNotice } from './FilePreviewNotice'

export function FileData({ tab, store, generation }: { tab: FileTab; store: FileBrowserStore; generation: number }) {
  const { t } = useI18n()
  const metadata = useBinaryPreview<DataIndex>(tab, store, generation, { type: 'data-index' })
  const table = metadata.value?.tables.find(item => item.id === tab.previewState?.dataTable) ?? metadata.value?.tables[0]
  const rows = useDataPreview(tab, store, generation, metadata.value, table)
  const schema = tab.previewState?.dataView === 'schema'
  if (!metadata.value) return <FilePreviewNotice error={metadata.error} loading={!metadata.error} />
  if (!table) return <div data-file-data-empty role="status" className="flex min-h-0 flex-1 items-center justify-center p-5 text-xs text-muted-foreground">{t('files.data.empty')}</div>
  const preview = schema ? { ...rows, status: 'ready' as const, busy: false, error: undefined, rows: [[t('files.data.column'), t('files.data.type')], ...table.columns.map(column => [column.name, column.type])],
    columns: 2, rowNumbers: null, totalRows: table.columns.length, truncated: false, eof: true, sheet: table.id + ':schema', loadMore: () => {} } : rows
  return <div data-file-data={metadata.value.format} className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-border/40 px-2 py-1">
      {metadata.value.tables.length > 1 ? <Select value={table.id} onValueChange={dataTable => store.setPreviewState(tab.path, { dataTable })} className="min-w-0 max-w-56 flex-1">
        <SelectTrigger aria-label={t('files.data.table')} className="h-7 text-caption"><SelectValue /></SelectTrigger>
        <SelectContent portal>{metadata.value.tables.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
      </Select> : <span className="min-w-0 truncate text-caption text-muted-foreground">{table.name}</span>}
      <Tabs value={schema ? 'schema' : 'rows'} variant="underline" onValueChange={value => store.setPreviewState(tab.path, { dataView: value as 'rows' | 'schema' })} className="ms-auto shrink-0">
        <TabsList className="h-7 gap-1 border-b-0 p-0"><TabsTrigger value="rows" className="min-h-0 px-2 py-1 text-caption">{t('files.data.rows')}</TabsTrigger><TabsTrigger value="schema" className="min-h-0 px-2 py-1 text-caption">{t('files.data.schema')}</TabsTrigger></TabsList>
      </Tabs>
    </div>
    {metadata.error ? <p role="status" className="shrink-0 px-3 py-1 text-xs text-destructive">{t(`files.previewError.${metadata.error}`)}</p> : null}
    {!schema && rows.status === 'error' ? <FilePreviewNotice error={rows.dataError} /> : <FileTableGrid tab={tab} store={store} preview={preview} />}
    {metadata.value.truncated ? <p role="status" className="shrink-0 border-t border-border/40 px-3 py-2 text-xs text-muted-foreground">{t('files.data.limited')}</p> : null}
  </div>
}
