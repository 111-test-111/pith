import type { ProcessMetric } from 'electron'
import type { ResourceProcessDTO, ResourceRuntimeDTO } from '../../shared/resources'
import type { NativeProcess } from './processes'

interface Counter { identity: string; cpuSeconds: number | null }
export class RuntimeSampler {
  private previous: { time: number; wallTime: number; counters: Map<number, Counter> } | null = null

  sample(metrics: ProcessMetric[], native: NativeProcess[], partial: boolean, logicalCores: number,
    wallTime = Date.now(), time = performance.now()): ResourceRuntimeDTO {
    const previous = this.previous, intervalMs = previous ? time - previous.time : null
    const counters = new Map<number, Counter>()
    const cpu = (pid: number, identity: string, seconds: number | undefined | null, creationTime: number): number | null => {
      const total = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : null
      counters.set(pid, { identity, cpuSeconds: total })
      if (!previous || !intervalMs || intervalMs <= 0 || total === null) return null
      const before = previous.counters.get(pid)
      if (before?.identity === identity && before.cpuSeconds !== null && total >= before.cpuSeconds) {
        return (total - before.cpuSeconds) * 100_000 / intervalMs
      }
      // A process born during this interval contributes its entire lifetime CPU.
      if (creationTime >= previous.wallTime && creationTime <= wallTime) return total * 100_000 / intervalMs
      return null
    }
    const bytes = (kib: number | undefined): number | null => kib !== undefined && Number.isFinite(kib) && kib >= 0 ? kib * 1024 : null
    const byPid = new Map(native.map(row => [row.pid, row]))
    const processes: ResourceProcessDTO[] = metrics.map(metric => {
      const os = byPid.get(metric.pid), cumulative = metric.cpu.cumulativeCPUUsage
      return { pid: metric.pid, creationTime: metric.creationTime,
        kind: metric.type === 'Browser' ? 'main' : metric.type === 'Tab' ? 'renderer' : metric.type === 'GPU' ? 'gpu' : metric.type === 'Utility' ? 'utility' : 'other',
        name: metric.name ?? metric.serviceName ?? null,
        cpuPercent: cpu(metric.pid, cumulative === undefined ? `native:${os?.identity}` : `electron:${metric.creationTime}`,
          cumulative ?? os?.cpuSeconds, metric.creationTime),
        // Linux getAppMetrics omits memory despite its .d.ts. Native RSS also
        // keeps macOS on the same resident-memory basis as external children.
        residentBytes: os ? os.residentBytes : bytes(metric.memory?.workingSetSize) }
    })
    const seen = new Set(processes.map(row => row.pid))
    for (const child of native) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      processes.push({ pid: child.pid, creationTime: child.creationTime, kind: 'child', name: child.name,
        cpuPercent: cpu(child.pid, `native:${child.identity}`, child.cpuSeconds, child.creationTime), residentBytes: child.residentBytes })
    }
    this.previous = { time, wallTime, counters }
    const sum = (key: 'cpuPercent' | 'residentBytes'): number | null => partial || !processes.length || processes.some(row => row[key] === null)
      ? null : processes.reduce((total, row) => total + row[key]!, 0)
    return { sampledAt: wallTime, intervalMs, logicalCores, cpuPercent: sum('cpuPercent'), residentBytes: sum('residentBytes'), processes, partial }
  }
}
