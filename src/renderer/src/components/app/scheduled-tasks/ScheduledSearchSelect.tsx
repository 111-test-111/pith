import { memo, useMemo, useState } from 'react'
import {
  Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput,
  ComboboxItem, ComboboxList, ComboboxTrigger
} from '@/components/motion/combobox'
import { useI18n } from '@/i18n'

interface Option { value: string; label: string }

/** A bounded composition of beUI's portalled Combobox for project/session lists. */
export const ScheduledSearchSelect = memo(function ScheduledSearchSelect({
  value,
  onChange,
  options,
  label,
  invalid
}: {
  value: string
  onChange: (value: string) => void
  options: readonly Option[]
  label: string
  invalid?: boolean
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const matches = needle ? options.filter((option) => option.label.toLocaleLowerCase().includes(needle) || option.value.toLocaleLowerCase().includes(needle)) : options
    const head = matches.slice(0, 40)
    const selected = options.find((option) => option.value === value)
    if (selected && !head.some((option) => option.value === selected.value)) head.unshift(selected)
    return head
  }, [options, query, value])

  return (
    <Combobox value={value} onValueChange={onChange} query={query} onQueryChange={setQuery}>
      <ComboboxTrigger className={`h-9 min-w-0 text-xs ${invalid ? 'text-destructive hover:bg-destructive/10' : ''}`}>
        <ComboboxInput aria-label={label} placeholder={label} className="text-xs" />
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxList ariaLabel={label}>
          {visible.map((option) => (
            <ComboboxItem key={option.value} value={option.value} textValue={option.label} className="text-xs">{option.label}</ComboboxItem>
          ))}
          <ComboboxEmpty>{t('scheduledTasks.editor.noMatches')}</ComboboxEmpty>
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
})
