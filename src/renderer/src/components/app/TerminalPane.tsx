import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Plus, X } from '@/lib/icons'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { Button } from '@/components/motion/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/motion/context-menu'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { LabelTooltip } from './LabelTooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { TerminalStore } from '@/state/terminal-store'

export function TerminalPane({ terminals, onNew, onEmpty }: {
  terminals: TerminalStore
  onNew: () => void
  onEmpty: () => void
}) {
  const { t } = useI18n()
  const { tabs, active } = useSyncExternalStore(terminals.subscribe, terminals.getSnapshot)
  const host = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  // One menu for the pane: the target is the active emulator, resolved through
  // the store, so no per-row wrapper touches the xterm host element.
  const [menuOpen, setMenuOpen] = useState(false)
  const refocus = useRef(false)
  // Read the live selection while open (xterm's macOS right-click selects the
  // word before React dispatches), so Copy reflects what is actually selected.
  const canCopy = menuOpen && !!active && terminals.hasSelection(active)
  const tab = tabs.find((item) => item.id === active)
  const showScreen = tab?.status === 'starting' || tab?.status === 'running'
  const promptLabel = t('terminal.input')
  const tooMuchOutput = t('terminal.tooMuchOutput')
  useEffect(() => {
    if (showScreen && active && host.current) return terminals.attach(active, host.current, promptLabel, tooMuchOutput)
    return undefined
  }, [terminals, active, showScreen, promptLabel, tooMuchOutput])
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  // The menu takes focus to its first item; hand it back to the active emulator
  // on close so the keyboard keeps working without a click.
  useEffect(() => {
    if (menuOpen || !refocus.current) return
    refocus.current = false
    const frame = requestAnimationFrame(() => { if (active) terminals.focus(active) })
    return () => cancelAnimationFrame(frame)
  }, [menuOpen, active, terminals])

  const close = (id: string): void => {
    terminals.close(id)
    if (terminals.getSnapshot().tabs.length === 0) onEmpty()
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-terminal-pane
      onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <div ref={strip} className="min-w-0 flex-1 overflow-x-auto p-1" onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = tabs.findIndex((item) => item.id === active)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
          if (tabs[next]) {
            terminals.select(tabs[next].id)
            requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
          }
        }}>
          <Tabs value={active ?? ''} onValueChange={terminals.select} variant="segment" className="w-max">
            <TabsList className="gap-1 bg-muted/60 p-0.5">
              {tabs.map((item) => {
                const label = item.title || t('terminal.tab', { n: item.number })
                return (
                  <div key={item.id} className="group/terminal relative flex items-center" data-terminal-tab={item.id}>
                    <TabsTrigger value={item.id}
                      indicatorClassName="bg-background shadow-xs"
                      className={cn('h-7 min-h-0 pl-2.5 pr-7', active === item.id && 'text-foreground')}>
                      <LabelTooltip content={item.info?.cwd} wrap wrapperClassName="max-w-36">
                        <span className="truncate text-xs">{label}</span>
                      </LabelTooltip>
                    </TabsTrigger>
                    <Tooltip content={t('terminal.close', { label })} wrapperClassName="absolute right-0.5 z-10">
                      <Button variant="ghost" size="icon" aria-label={t('terminal.close', { label })}
                        onClick={() => close(item.id)}
                        className={cn('size-5 rounded-md group-hover/terminal:opacity-100 focus-visible:opacity-100', active === item.id ? 'opacity-100' : 'opacity-0')}>
                        <X aria-hidden="true" className="size-3" />
                      </Button>
                    </Tooltip>
                  </div>
                )
              })}
            </TabsList>
          </Tabs>
        </div>
        <Tooltip content={t('terminal.new')}>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t('terminal.new')} onClick={onNew}>
            <Plus aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
      </div>
      {tab && tab.status !== 'running' && tab.status !== 'starting' ? (
        <div role="status" className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          {/* The status is the whole page for an exited terminal, so it carries the
              tone: a clean exit is neutral, a failure is destructive. The starting
              phase renders no row — the surface attaches in well under a second,
              and a text line that flashes for a few frames reads as a glitch. The
              message follows the terminal's own body size. */}
          <AnimatedBadge
            size="sm"
            className="h-auto min-h-6 max-w-full py-1 text-terminal leading-normal"
            status={tab.status === 'exited' && !tab.exitCode ? 'neutral' : 'danger'}
          >
            {tab.status === 'exited'
              ? t('terminal.exited', { code: tab.exitCode ?? 0 })
              : t(tab.error === 'directory' ? 'terminal.directoryError' : 'terminal.startError')}
          </AnimatedBadge>
        </div>
      ) : null}
      {showScreen ? <div className="min-h-0 min-w-0 flex-1 overflow-hidden p-2" role="tabpanel" aria-label={t('sidebar.terminal')}>
        <ContextMenu open={menuOpen} onOpenChange={next => { setMenuOpen(next); if (!next) refocus.current = true }}>
          <ContextMenuTrigger>
            <div ref={host} className="h-full w-full" data-terminal-surface />
          </ContextMenuTrigger>
          <ContextMenuContent ariaLabel={t('terminal.menu')}>
            <ContextMenuItem disabled={!canCopy} onSelect={() => {
              if (active) void navigator.clipboard?.writeText(terminals.selection(active)).catch(() => {})
            }}>{t('terminal.copy')}</ContextMenuItem>
            <ContextMenuItem onSelect={() => {
              if (!active) return
              const id = active
              void navigator.clipboard?.readText().then(text => { if (text) terminals.paste(id, text) }).catch(() => {})
            }}>{t('terminal.paste')}</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => { if (active) terminals.clear(active) }}>{t('terminal.clear')}</ContextMenuItem>
            <ContextMenuItem onSelect={() => {
              if (!active) return
              terminals.selectAll(active)
            }}>{t('terminal.selectAll')}</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div> : null}
    </div>
  )
}
