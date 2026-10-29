import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Ban, Check, Pencil, RefreshCw, Search, X } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import {
  SHORTCUTS,
  bindingError,
  bindingFromEvent,
  findShortcutConflict,
  shortcutAriaLabel,
  type ShortcutId
} from '@/lib/shortcuts/keyboard-shortcuts'
import {
  getShortcutSnapshot,
  saveShortcutDisabled,
  saveShortcutOverrides
} from '@/lib/shortcuts/shortcut-store'
import { useShortcutBindings } from '@/lib/shortcuts/use-shortcuts'
import { SettingsGroup } from './SettingsRow'
import { ShortcutKeys } from '../ShortcutKeys'
import { cn } from '@/lib/utils'

const GROUPS = ['chat', 'navigation', 'panes'] as const

/**
 * Settings → Shortcuts: every app command with its current binding. A row's
 * edit turns the binding display into a capture surface (the next chord you
 * press becomes the binding, Enter/✓ saves, Esc/✕ cancels); reset restores
 * the default and the ban switch suspends the command without losing its
 * binding. Validation (reserved keys, missing modifier, conflicts) reports
 * inline, so a bad chord never reaches the dispatcher.
 */
export function ShortcutsSection() {
  const { t } = useI18n()
  const { bindings, overrides, disabled, mac, storageError } = useShortcutBindings()
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<ShortcutId | null>(null)
  const [candidate, setCandidate] = useState<string | null>(null)
  const [error, setError] = useState('')
  /** A non-editing row's problem (a reset that would collide), shown inline. */
  const [rowIssue, setRowIssue] = useState<{ id: ShortcutId; message: string } | null>(null)
  const captureRef = useRef<HTMLDivElement | null>(null)
  const returnFocus = useRef<HTMLButtonElement | null>(null)

  useLayoutEffect(() => {
    if (recording) captureRef.current?.focus()
    else if (returnFocus.current?.isConnected) returnFocus.current.focus()
  }, [recording])

  const name = (id: ShortcutId) => t(`shortcuts.${id}` as MessageKey)
  const finish = () => {
    setRecording(null)
    setCandidate(null)
    setError('')
  }
  const validate = (binding: string, id: ShortcutId): string => {
    const current = getShortcutSnapshot()
    const invalid = bindingError(binding, id, current.mac)
    if (invalid) return t(`shortcuts.error.${invalid}` as MessageKey)
    const conflict = findShortcutConflict(current.bindings, binding, id, current.mac)
    return conflict ? t('shortcuts.error.conflict', { action: name(conflict) }) : ''
  }
  const save = () => {
    if (!recording || !candidate) return
    const problem = validate(candidate, recording)
    if (problem) {
      setError(problem)
      return
    }
    saveShortcutOverrides({ ...getShortcutSnapshot().overrides, [recording]: [candidate] })
    finish()
  }

  // The capture surface owns the whole window while recording: chords never
  // reach the dispatcher (data-shortcut-recording also fences it), buttons
  // keep their plain Enter/Space activation, Tab keeps focus navigation.
  useEffect(() => {
    if (!recording) return
    const capture = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('button') &&
        ['Enter', ' '].includes(event.key) &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        return
      }
      if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.isComposing || event.keyCode === 229 || event.repeat) return
      if (event.key === 'Escape') {
        finish()
        return
      }
      if (
        event.key === 'Enter' &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey &&
        candidate
      ) {
        save()
        return
      }
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return
      const binding = bindingFromEvent(event, mac)
      const problem = binding ? validate(binding, recording) : t('shortcuts.error.unsupported')
      setCandidate(binding)
      setError(problem)
    }
    const blur = () => finish()
    window.addEventListener('keydown', capture, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', capture, true)
      window.removeEventListener('blur', blur)
    }
  })

  const start = (id: ShortcutId, button: HTMLButtonElement) => {
    returnFocus.current = button
    setRowIssue(null)
    setRecording(id)
    setCandidate(null)
    setError('')
  }
  // A reset-collision note floats until the next gesture anywhere — it never
  // occupies row space.
  useEffect(() => {
    if (!rowIssue) return
    const dismiss = () => setRowIssue(null)
    window.addEventListener('pointerdown', dismiss, true)
    return () => window.removeEventListener('pointerdown', dismiss, true)
  }, [rowIssue])
  const toggleDisabled = (id: ShortcutId) => {
    const next = { ...getShortcutSnapshot().disabled }
    if (next[id]) delete next[id]
    else next[id] = true
    saveShortcutDisabled(next)
  }
  const reset = (id: ShortcutId) => {
    // Restoring the default must not collide with another row's override:
    // the resolver would silently drop the default, which reads as data loss.
    const defaults = SHORTCUTS.find((command) => command.id === id)!.defaults
    const current = getShortcutSnapshot()
    const conflict = defaults
      .map((binding) => findShortcutConflict(current.bindings, binding, id, current.mac))
      .find(Boolean)
    if (conflict) {
      setRowIssue({ id, message: t('shortcuts.error.conflict', { action: name(conflict) }) })
      return
    }
    setRowIssue(null)
    const next = { ...current.overrides }
    delete next[id]
    saveShortcutOverrides(next)
    if (recording === id) finish()
  }

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matches = SHORTCUTS.filter(({ id }) => {
    if (words.length === 0) return true
    const text = [
      name(id),
      t(`shortcuts.${id}.hint` as MessageKey),
      ...bindings[id].flatMap((binding) => [
        shortcutAriaLabel(binding, mac),
        binding
      ])
    ]
      .join(' ')
      .toLowerCase()
    return words.every((word) => text.includes(word))
  })

  return (
    <div className="space-y-6">
      <p className="px-1 text-xs leading-ui text-muted-foreground">{t('shortcuts.intro')}</p>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            value={query}
            onChange={(value) => {
              setQuery(value)
              if (recording) finish()
            }}
            placeholder={t('shortcuts.search')}
            aria-label={t('shortcuts.search')}
            leftIcon={<Search aria-hidden="true" />}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={Object.keys(overrides).length === 0 || !!recording}
          onClick={() => saveShortcutOverrides({})}
        >
          {t('shortcuts.resetAll')}
        </Button>
      </div>
      {storageError ? (
        <p role="alert" className="px-1 text-xs text-destructive">
          {t('shortcuts.storageError')}
        </p>
      ) : null}
      {GROUPS.map((group) => {
        const rows = matches.filter((command) => command.group === group)
        if (rows.length === 0) return null
        return (
          <SettingsGroup key={group} title={t(`shortcuts.group.${group}` as MessageKey)}>
            {rows.map(({ id }) => {
              const editing = recording === id
              const binding = editing ? candidate : bindings[id][0]
              const isDisabled = !!disabled[id]
              return (
                // relative: the floating error note anchors to the row's
                // bottom-right (the buttons' right edge), never to the page.
                <div key={id} className="relative px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0 flex-1 basis-44">
                      <p
                        className={cn(
                          'text-sm font-medium text-foreground',
                          isDisabled && 'text-muted-foreground line-through'
                        )}
                      >
                        {name(id)}
                      </p>
                      <p className="mt-0.5 text-xs leading-ui-tight text-muted-foreground">
                        {t(`shortcuts.${id}.hint` as MessageKey)}
                      </p>
                    </div>
                    <div className="relative flex shrink-0 items-center gap-1.5">
                      {/* Fixed-width display: entering/leaving record mode and
                          growing candidates never resize the row. */}
                      <div
                        ref={editing ? captureRef : undefined}
                        data-shortcut-recording={editing || undefined}
                        role={editing ? 'textbox' : undefined}
                        tabIndex={editing ? 0 : undefined}
                        aria-label={
                          editing
                            ? `${t('shortcuts.pressKeys')}${binding ? `: ${shortcutAriaLabel(binding, mac)}` : ''}`
                            : undefined
                        }
                        aria-invalid={(editing && !!error) || undefined}
                        aria-live={editing ? 'polite' : undefined}
                        aria-description={editing ? error || t('shortcuts.recordHint') : undefined}
                        className={cn(
                          // Same outer box in both states, so the recording
                          // frame's left edge lands exactly where the idle
                          // caps start (idle has no frame: flush padding).
                          'flex min-h-7 w-[calc(var(--app-text-ui-keycap)*9+6rem)] items-center justify-start rounded-control outline-none',
                          editing
                            ? 'border border-ring bg-transparent px-1.5'
                            : 'px-0',
                          editing && error && 'border-destructive',
                          isDisabled && 'opacity-50'
                        )}
                      >
                        {binding ? (
                          <ShortcutKeys binding={binding} mac={mac} />
                        ) : (
                          <span className="px-1 text-xs text-muted-foreground">
                            {t(editing ? 'shortcuts.pressKeys' : 'shortcuts.unassigned')}
                          </span>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={!!recording}
                        aria-pressed={isDisabled}
                        aria-label={t(isDisabled ? 'shortcuts.enable' : 'shortcuts.disable', {
                          action: name(id)
                        })}
                        onClick={() => toggleDisabled(id)}
                      >
                        <Ban
                          aria-hidden="true"
                          className={cn('size-3.5', isDisabled && 'text-destructive')}
                        />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={editing ? !candidate || !!error : !!recording}
                        aria-label={editing ? t('shortcuts.save') : t('shortcuts.edit', { action: name(id) })}
                        onClick={(event) =>
                          editing ? save() : start(id, event.currentTarget)
                        }
                      >
                        {editing ? (
                          <Check aria-hidden="true" className="size-3.5" />
                        ) : (
                          <Pencil aria-hidden="true" className="size-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={!editing && (!!recording || !(id in overrides))}
                        aria-label={editing ? t('shortcuts.cancel') : t('shortcuts.reset', { action: name(id) })}
                        onClick={() => (editing ? finish() : reset(id))}
                      >
                        {editing ? (
                          <X aria-hidden="true" className="size-3.5" />
                        ) : (
                          <RefreshCw aria-hidden="true" className="size-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>
                  {/* Problems float under the controls instead of taking row
                      space: the row count and heights never change mid-edit. */}
                  {(editing && error) || (!editing && rowIssue?.id === id) ? (
                    <p
                      role="alert"
                      className="pointer-events-none absolute right-0 top-full z-20 mt-1.5 w-max max-w-72 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs leading-ui-tight text-destructive shadow-lg"
                    >
                      {editing ? error : rowIssue?.message}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </SettingsGroup>
        )
      })}
      {matches.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">{t('shortcuts.noResults')}</p>
      ) : null}
      <p className="px-1 text-xs leading-ui text-muted-foreground/70">{t('shortcuts.footnote')}</p>
    </div>
  )
}
