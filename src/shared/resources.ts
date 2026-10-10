/** Read-only resource measurements. Bytes always mean bytes, CPU uses one
 * logical core as 100%. Missing measurements are null, never invented zeros. */
export interface ResourceProcessDTO {
  pid: number
  creationTime: number
  kind: 'main' | 'renderer' | 'gpu' | 'utility' | 'other' | 'child'
  name: string | null
  cpuPercent: number | null
  residentBytes: number | null
}

export interface ResourceRuntimeDTO {
  sampledAt: number
  intervalMs: number | null
  logicalCores: number
  cpuPercent: number | null
  residentBytes: number | null
  processes: ResourceProcessDTO[]
  /** External descendants could not be enumerated or measured. */
  partial: boolean
}

export const RESOURCE_STORAGE_CATEGORIES = [
  'sessions', 'rewind', 'trajectory', 'library', 'browser', 'cache',
  'indexes', 'logs', 'workspace', 'extensions', 'configuration', 'other'
] as const
export type ResourceStorageCategory = typeof RESOURCE_STORAGE_CATEGORIES[number]
export type ResourceStorageRootKind = 'app' | 'pi' | 'library' | 'browser' | 'logs' | 'crashes'
export interface ResourceStorageRootDTO {
  kind: ResourceStorageRootKind
  path: string
  status: 'ok' | 'missing' | 'unreadable'
}
export interface ResourceStorageEntryDTO {
  category: ResourceStorageCategory
  logicalBytes: number
  /** Filesystem-reported allocation, including directories and symlinks.
   * Unsupported platforms report null. This is not exclusive physical usage
   * on filesystems with shared extents, compression or snapshots. */
  allocatedBytes: number | null
  files: number
}
export interface ResourceStorageIssueDTO {
  path: string
  reason: 'unreadable' | 'changed' | 'overflow'
}
export interface ResourceStorageDTO {
  startedAt: number
  completedAt: number
  logicalBytes: number
  allocatedBytes: number | null
  files: number
  entries: ResourceStorageEntryDTO[]
  roots: ResourceStorageRootDTO[]
  /** Any omitted/racing entries make this a partial scan. */
  partial: boolean
  issueCount: number
  /** Bounded details; issueCount retains the complete count. */
  issues: ResourceStorageIssueDTO[]
}

export type ResourceResult<T> = { ok: true; value: T } | { ok: false; code: 'unavailable' }
