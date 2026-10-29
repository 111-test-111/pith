import { useEffect, useRef, useState } from 'react'
import type { DebugDisassemblyDTO, DebugMemoryDTO, DebugModulesPageDTO, DebugNativeBreakpointsDTO, DebugSessionDTO, DebugStackFrameDTO, DebugSourceContentDTO } from '../../../../shared/types'
import { AgentCodeLine } from '@/components/agents/agent-code'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { Plus, X } from '@/lib/icons'
import { FadeScroll } from './FadeScroll'

/** Addresses are strings end to end. BigInt is used only to compare explicit
 * hexadecimal instruction addresses, never to reinterpret opaque DAP refs. */
function sameAddress(left: string, right?: string): boolean {
  if (left === right) return true
  return !!right && /^0x[\da-f]+$/i.test(left) && /^0x[\da-f]+$/i.test(right) && BigInt(left) === BigInt(right)
}

export function DebugNativeView({ session, frame, cwd, memorySelection }: {
  session: DebugSessionDTO; frame?: DebugStackFrameDTO; cwd: string; memorySelection?: { reference: string; serial: number }
}) {
  const { t } = useI18n()
  const capabilities = session.capabilities
  const source = frame?.source, pc = frame?.instructionPointerReference
  const canDisassemble = !!capabilities?.supportsDisassembleRequest && !!pc
  const [tab, setTab] = useState(source?.kind === 'file' ? 'source' : canDisassemble ? 'assembly' : source ? 'source' : capabilities?.supportsReadMemoryRequest ? 'memory' : 'modules')
  const [document, setDocument] = useState<DebugSourceContentDTO | null>(null)
  const [sourceMissing, setSourceMissing] = useState(false)
  const [sourceOffset, setSourceOffset] = useState<number | null>(source?.kind === 'adapter' ? null : Math.max(0, (frame?.line ?? 1) - 11))
  const [sourceHistory, setSourceHistory] = useState<number[]>([])
  const [assembly, setAssembly] = useState<DebugDisassemblyDTO | null>(null)
  const [instructionOffset, setInstructionOffset] = useState(0)
  const [memory, setMemory] = useState<DebugMemoryDTO | null>(null)
  const [reference, setReference] = useState(pc ?? '')
  const [referenceDraft, setReferenceDraft] = useState(pc ?? '')
  const [memoryOffset, setMemoryOffset] = useState(0)
  const [modules, setModules] = useState<DebugModulesPageDTO | null>(null)
  const [moduleOffset, setModuleOffset] = useState(0)
  const [points, setPoints] = useState<DebugNativeBreakpointsDTO>({ instruction: [], function: [] })
  const [functionDraft, setFunctionDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const target = { sessionPath: session.sessionPath, debugId: session.id, stopId: session.stopId }
  useEffect(() => {
    if (tab === 'assembly' && !canDisassemble || tab === 'memory' && !capabilities?.supportsReadMemoryRequest || tab === 'modules' && !capabilities?.supportsModulesRequest) {
      setTab(source ? 'source' : canDisassemble ? 'assembly' : capabilities?.supportsReadMemoryRequest ? 'memory' : 'modules')
    }
  }, [tab, canDisassemble, capabilities?.supportsReadMemoryRequest, capabilities?.supportsModulesRequest, source])
  const sourceIdentity = source?.kind === 'adapter' ? `adapter:${source.sourceReference}` : source?.path
  useEffect(() => {
    setSourceOffset(source?.kind === 'adapter' ? null : Math.max(0, (frame?.line ?? 1) - 11))
    setSourceHistory([])
  }, [session.id, session.stopId, sourceIdentity, frame?.line])
  useEffect(() => {
    if (!memorySelection) return
    setReference(memorySelection.reference); setReferenceDraft(memorySelection.reference); setMemoryOffset(0); setTab('memory')
  }, [memorySelection])

  useEffect(() => {
    if (!capabilities?.supportsInstructionBreakpoints && !capabilities?.supportsFunctionBreakpoints) return
    let current = true
    void window.pi.debugAction({ ...target, action: 'breakpoints.native' }).then(value => { if (current) setPoints(value as DebugNativeBreakpointsDTO) }).catch(() => {})
    return () => { current = false }
  }, [session.id, session.revision, capabilities?.supportsInstructionBreakpoints, capabilities?.supportsFunctionBreakpoints])

  useEffect(() => {
    if (!source || tab !== 'source') return
    let current = true
    setDocument(null); setLoading(true); setError(false)
    const request = source.kind === 'adapter'
      ? window.pi.debugSource({ ...target, sourceReference: source.sourceReference, sourceVersion: session.sourceVersion ?? 0,
        ...(sourceOffset === null ? { startLine: Math.max(1, (frame?.line ?? 1) - 10) } : { offset: sourceOffset }), limit: 8192 })
      : window.pi.readFileDocument({ cwd, path: source.path }).then(result => {
        if (result.error || result.text === undefined) throw new Error('source unavailable')
        return { content: result.text, truncated: result.truncated, debugId: session.id, sourceReference: 0, sourceVersion: session.sourceVersion ?? 0 }
      })
    void request.then(value => { if (current) { setDocument(value); setSourceMissing(false) } }).catch(() => {
      if (current) { setSourceMissing(true); if (canDisassemble) setTab('assembly'); else setError(true) }
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [tab, session.id, session.stopId, session.sourceVersion, sourceIdentity, sourceOffset, frame?.line, cwd])

  useEffect(() => {
    if (tab !== 'assembly' || !canDisassemble || !pc) return
    let current = true
    setAssembly(null); setError(false); setLoading(true)
    void window.pi.debugAction({ ...target, action: 'disassemble', memoryReference: pc, instructionOffset, count: 32 })
      .then(value => { if (current) setAssembly(value as DebugDisassemblyDTO) }).catch(() => { if (current) setError(true) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [tab, session.id, session.stopId, pc, instructionOffset, canDisassemble])

  useEffect(() => {
    if (tab !== 'memory' || !reference || !capabilities?.supportsReadMemoryRequest) return
    let current = true
    setMemory(null); setError(false); setLoading(true)
    void window.pi.debugAction({ ...target, action: 'memory.read', memoryReference: reference, offset: memoryOffset, count: 128 })
      .then(value => { if (current) setMemory(value as DebugMemoryDTO) }).catch(() => { if (current) setError(true) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [tab, session.id, session.stopId, reference, memoryOffset, capabilities?.supportsReadMemoryRequest])

  useEffect(() => {
    if (tab !== 'modules' || !capabilities?.supportsModulesRequest) return
    let current = true
    setModules(null); setError(false); setLoading(true)
    void window.pi.debugAction({ ...target, action: 'modules', start: moduleOffset, count: 20 })
      .then(value => { if (current) setModules(value as DebugModulesPageDTO) }).catch(() => { if (current) setError(true) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [tab, session.id, session.stopId, moduleOffset, capabilities?.supportsModulesRequest])

  const mutate = (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(false)
    void work().then(value => { if (alive.current) setPoints(value as DebugNativeBreakpointsDTO) })
      .catch(() => { if (alive.current) setError(true) }).finally(() => { if (alive.current) setBusy(false) })
  }
  const selectMemory = (address: string) => { setReference(address); setReferenceDraft(address); setMemoryOffset(0); setTab('memory') }
  if (!source && !canDisassemble && !capabilities?.supportsReadMemoryRequest && !capabilities?.supportsModulesRequest) return null
  const core = session.kind === 'core'
  const lines = document?.content ? document.content.split('\n') : []
  const visibleLines = source?.kind === 'adapter'
    ? document?.content.endsWith('\n') ? lines.slice(0, -1) : lines
    : lines.slice(sourceOffset ?? 0, (sourceOffset ?? 0) + 100)
  const pager = (previous: () => void, next: () => void, previousDisabled: boolean, nextDisabled: boolean) => (
    <div className="mt-1 flex justify-between gap-2">
      <Button variant="ghost" className="h-7 px-2 text-xs" onClick={previous} disabled={loading || previousDisabled}>{t('debug.previousPage')}</Button>
      <Button variant="ghost" className="h-7 px-2 text-xs" onClick={next} disabled={loading || nextDisabled}>{t('debug.nextPage')}</Button>
    </div>
  )
  return <section className="min-w-0 space-y-2 border-b border-border/60 px-3 py-2" aria-label={t('debug.nativeInspection')} data-debug-native>
    {pc ? <p className="break-all font-mono text-xs text-muted-foreground">{t('debug.pc', { address: pc })}</p> : null}
    {frame?.moduleId !== undefined ? <p className="break-all font-mono text-code-inline text-muted-foreground">{t('debug.moduleIdentity', { id: String(frame.moduleId) })}</p> : null}
    <Tabs value={tab} onValueChange={value => { setError(false); setLoading(false); setTab(value) }} variant="underline">
      {/* The strip hugs its tabs: a block-level list stretched the rail across
          the pane and left a card-coloured blank to the right of the last tab. */}
      <TabsList className="min-w-0 flex-wrap p-0">
        {source ? <TabsTrigger value="source" className="min-h-0 min-w-0 px-2 py-1 text-xs">{t('debug.source')}</TabsTrigger> : null}
        {canDisassemble ? <TabsTrigger value="assembly" className="min-h-0 min-w-0 px-2 py-1 text-xs">{t('debug.assembly')}</TabsTrigger> : null}
        {capabilities?.supportsReadMemoryRequest ? <TabsTrigger value="memory" className="min-h-0 min-w-0 px-2 py-1 text-xs">{t('debug.memory')}</TabsTrigger> : null}
        {capabilities?.supportsModulesRequest ? <TabsTrigger value="modules" className="min-h-0 min-w-0 px-2 py-1 text-xs">{t('debug.modules')}</TabsTrigger> : null}
      </TabsList>
    </Tabs>
    {sourceMissing ? <p className="text-xs text-muted-foreground">{t('debug.sourceUnavailable')}</p> : null}
    {error ? <p role="alert" className="break-words text-xs text-destructive">{t('debug.inspectionFailed')}</p> : null}
    {loading ? <p role="status" className="text-xs text-muted-foreground">{t('debug.loading')}</p> : null}
    {tab === 'source' && document ? <div data-debug-source>
      <p className="mb-1 break-all text-xs text-muted-foreground">{source?.name ?? source?.path}</p>
      <FadeScroll className="max-h-64 overflow-x-auto p-1">
        {visibleLines.map((line, index) => {
          const lineNumber = source?.kind === 'adapter' ? (document.startLine ?? 1) + index : (sourceOffset ?? 0) + index + 1
          return <div key={lineNumber} className={cn('flex min-w-max gap-3 font-mono text-code', lineNumber === frame?.line && 'bg-accent')} data-debug-source-line={lineNumber}>
          <span className="w-8 shrink-0 text-right text-muted-foreground">{lineNumber}{source?.kind === 'adapter' && index === 0 && document.continuedLine ? '↪' : ''}</span><AgentCodeLine code={line} />
        </div>})}
      </FadeScroll>
      {document.truncated && source?.kind !== 'adapter' ? <p className="text-xs text-muted-foreground">{t('debug.sourceTruncated')}</p> : null}
      {source?.kind === 'adapter'
        ? pager(() => {
          setSourceOffset(sourceHistory.at(-1) ?? document.previousOffset ?? 0)
          setSourceHistory(sourceHistory.slice(0, -1))
        }, () => {
          setSourceHistory([...sourceHistory, document.offset ?? 0])
          setSourceOffset(document.nextOffset ?? 0)
        }, sourceHistory.length === 0 && (document.offset ?? 0) === 0,
        (document.nextOffset ?? document.content.length) >= (document.totalChars ?? document.content.length))
        : pager(() => setSourceOffset(Math.max(0, (sourceOffset ?? 0) - 100)), () => setSourceOffset((sourceOffset ?? 0) + 100),
          (sourceOffset ?? 0) === 0, (sourceOffset ?? 0) + 100 >= lines.length)}
    </div> : null}
    {tab === 'assembly' && canDisassemble && assembly ? <div data-debug-assembly>
      <FadeScroll className="max-h-64 overflow-x-auto p-1">
        {assembly.instructions.map((instruction, index) => {
          const bound = points.instruction.find(point => {
            const reference = point.boundInstructionReference ?? point.instructionReference
            const offset = point.boundInstructionReference ? point.boundOffset ?? 0 : point.offset ?? 0
            return /^0x[\da-f]+$/i.test(reference) ? sameAddress(`0x${(BigInt(reference) + BigInt(offset)).toString(16)}`, instruction.address) : offset === 0 && sameAddress(reference, instruction.address)
          })
          return <div key={`${instruction.address}:${index}`} data-debug-pc={sameAddress(instruction.address, pc) || undefined} className={cn('flex min-w-max items-start gap-1 font-mono text-code', sameAddress(instruction.address, pc) && 'bg-accent')}>
            <Button variant="ghost" size="icon" className="size-6 shrink-0" disabled={core || busy || !capabilities?.supportsInstructionBreakpoints || instruction.presentationHint === 'invalid'}
              aria-label={t(bound ? 'debug.removeInstructionBreakpoint' : 'debug.addInstructionBreakpoint', { address: instruction.address })}
              onClick={() => mutate(() => window.pi.debugAction({ ...target, action: 'breakpoints.instruction.toggle', instructionReference: instruction.address }))}>
              <span className={cn('size-2 rounded-full', bound?.verified ? 'bg-destructive' : bound ? 'bg-muted-foreground' : 'border border-border')} />
            </Button>
            <Button variant="ghost" className="h-auto min-h-6 shrink-0 px-1 font-mono text-code" disabled={!capabilities?.supportsReadMemoryRequest || instruction.presentationHint === 'invalid'} onClick={() => selectMemory(instruction.address)} aria-label={t('debug.inspectAddress', { address: instruction.address })}>{instruction.address}</Button>
            <span className="text-muted-foreground">{instruction.instructionBytes}</span><AgentCodeLine code={instruction.instruction} />
            {instruction.symbol ? <span className="text-muted-foreground">{instruction.symbol}</span> : null}
          </div>
        })}
      </FadeScroll>
      {pager(() => setInstructionOffset(instructionOffset - 32), () => setInstructionOffset(instructionOffset + 32), false, assembly.instructions.length === 0)}
    </div> : null}
    {tab === 'memory' ? <div data-debug-memory>
      <form className="flex min-w-0 items-center gap-1" onSubmit={event => { event.preventDefault(); selectMemory(referenceDraft.trim()) }}>
        <Input value={referenceDraft} onChange={setReferenceDraft} aria-label={t('debug.memoryReference')} placeholder={t('debug.memoryReference')} classNames={{ input: 'font-mono' }} />
        <Button type="submit" variant="ghost" className="h-7 shrink-0 px-2 text-xs" disabled={!referenceDraft.trim() || loading}>{t('debug.readMemory')}</Button>
      </form>
      {memory ? <>
        <p className="my-1 break-all font-mono text-code-inline text-muted-foreground">{memory.address}</p>
        <FadeScroll className="max-h-52 overflow-x-auto p-1"><pre className="font-mono text-code text-foreground">{memory.hex.split(' ').filter(Boolean).reduce<string[]>((rows, byte, index) => {
          if (index % 16 === 0) rows.push(`${index.toString(16).padStart(4, '0')}  `)
          rows[rows.length - 1] += `${byte} `; return rows
        }, []).join('\n')}</pre></FadeScroll>
        {memory.truncated ? <p className="text-xs text-muted-foreground">{t('debug.memoryPartial', { read: memory.bytesRead, requested: memory.requestedCount, unreadable: memory.unreadableBytes })}</p> : null}
        {pager(() => setMemoryOffset(memoryOffset - 128), () => setMemoryOffset(memoryOffset + 128), false, memory.bytesRead === 0)}
      </> : null}
    </div> : null}
    {tab === 'modules' && modules ? <div data-debug-modules>
      <FadeScroll className="max-h-64 p-1"><ul className="space-y-2">
        {modules.modules.map(module => <li key={module.id} className="min-w-0 text-xs">
          <p className="break-all font-medium text-foreground">{module.name}</p>
          <p className="break-all text-muted-foreground">{module.path}</p>
          <p className="break-all font-mono text-code-inline text-muted-foreground">{module.addressRange}</p>
          <p className="break-all text-muted-foreground">{module.symbolStatus ?? t('debug.symbolStatusUnknown')}</p>
          {module.symbolFilePath ? <p className="break-all text-muted-foreground">{module.symbolFilePath}</p> : null}
        </li>)}
      </ul></FadeScroll>
      {pager(() => setModuleOffset(Math.max(0, moduleOffset - 20)), () => setModuleOffset(moduleOffset + modules.modules.length), moduleOffset === 0, !modules.truncated || modules.modules.length === 0)}
    </div> : null}
    {!core && (capabilities?.supportsInstructionBreakpoints || capabilities?.supportsFunctionBreakpoints) ? <div className="space-y-1" data-debug-native-breakpoints>
      <h3 className="text-xs font-medium text-muted-foreground">{t('debug.nativeBreakpoints')}</h3>
      {points.instruction.map(point => <div key={`${point.instructionReference}:${point.offset ?? 0}`} className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1 break-all font-mono text-code-inline text-foreground"><span>{point.instructionReference}{point.offset ? ` + ${point.offset}` : ''}</span>
          <p className="text-muted-foreground">{point.message ?? (!point.verified ? t('debug.unverified') : '')}</p>
          {point.condition ? <p className="text-muted-foreground">{point.condition} · {t(point.conditionStatus === 'error' ? 'debug.conditionError' : 'debug.conditionUnvalidated')}</p> : null}
        </div>
        <Button variant="ghost" size="icon" className="size-6 shrink-0" disabled={busy} aria-label={t('debug.removeInstructionBreakpoint', { address: point.instructionReference })} onClick={() => mutate(() => window.pi.debugAction({ ...target, action: 'breakpoints.instruction.update', instructionReference: point.instructionReference, offset: point.offset, enabled: false }))}><X aria-hidden="true" className="size-3" /></Button>
      </div>)}
      {points.function.map(point => <div key={point.name} className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1 break-all text-xs text-foreground"><span className="font-mono text-code-inline">{point.name}</span><p className="text-muted-foreground">{point.message ?? (!point.verified ? t('debug.unverified') : '')}</p>
          {point.condition ? <p className="text-muted-foreground">{point.condition} · {t(point.conditionStatus === 'error' ? 'debug.conditionError' : 'debug.conditionUnvalidated')}</p> : null}
        </div>
        <Button variant="ghost" size="icon" className="size-6 shrink-0" disabled={busy} aria-label={t('debug.removeFunctionBreakpoint', { name: point.name })} onClick={() => mutate(() => window.pi.debugAction({ ...target, action: 'breakpoints.function.update', name: point.name, enabled: false }))}><X aria-hidden="true" className="size-3" /></Button>
      </div>)}
      {capabilities?.supportsFunctionBreakpoints ? <form className="flex min-w-0 items-center gap-1" onSubmit={event => { event.preventDefault(); const name = functionDraft.trim(); if (!name || points.function.some(point => point.name === name)) return; mutate(() => window.pi.debugAction({ ...target, action: 'breakpoints.function.update', name, enabled: true })); setFunctionDraft('') }}>
        <Input value={functionDraft} onChange={setFunctionDraft} aria-label={t('debug.functionName')} placeholder={t('debug.functionName')} classNames={{ input: 'font-mono' }} />
        <Button variant="ghost" type="submit" size="icon" className="size-7 shrink-0" disabled={busy || !functionDraft.trim()} aria-label={t('debug.addFunctionBreakpoint')}><Plus aria-hidden="true" className="size-3" /></Button>
      </form> : null}
    </div> : null}
  </section>
}
