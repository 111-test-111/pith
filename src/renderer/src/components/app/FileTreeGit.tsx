import type { FileDirectoryEntryDTO } from '../../../../shared/types'
import type { GitChange, GitLineStats } from '../../../../shared/git'
import { useI18n } from '@/i18n'
import { AlertTriangle, FileX, SquareDot, SquarePlus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { MiddleEllipsis } from './MiddleEllipsis'
import { GitLineCounts } from './git/GitLineCounts'

type TreeEntry = Pick<FileDirectoryEntryDTO, 'path' | 'name' | 'directory'>
type Translate = ReturnType<typeof useI18n>['t']

function deleted(file: GitChange) {
  return !file.conflict && (file.index === 'D' || file.worktree === 'D')
}

/** Missing tracked paths contribute to ancestor dots and remain browsable. */
export function indexFileTreeGit(root: string, changes: readonly GitChange[]) {
  const files = new Map<string, GitChange>()
  const folders = new Set<string>()
  const missing = new Map<string, Map<string, TreeEntry>>()
  // A staged deletion followed by an untracked replacement has two porcelain
  // records. Decorate the replacement, using the last record for that path.
  const paths = new Map(changes.map(file => [file.path, file]))
  for (const [relative, file] of paths) {
    const directory = relative.endsWith('/')
    const parts = relative.replace(/\/$/, '').split('/')
    const removed = deleted(file)
    let parent = root
    for (const [index, name] of parts.entries()) {
      const path = `${parent.replace(/\/$/, '')}/${name}`
      const folder = directory || index < parts.length - 1
      folders.add(parent)
      if (folder) folders.add(path)
      else files.set(path, file)
      if (removed) {
        const siblings = missing.get(parent) ?? new Map<string, TreeEntry>()
        siblings.set(path, { path, name, directory: folder })
        missing.set(parent, siblings)
      }
      parent = path
    }
  }
  return { files, folders, missing }
}

const added = { color: 'text-git-tree-added', icon: SquarePlus }
const modified = { color: 'text-git-tree-modified', icon: SquareDot }
const marks = {
  added,
  untracked: added,
  modified,
  typeChanged: modified,
  deleted: { color: 'text-git-tree-removed', icon: FileX },
  conflicted: { color: 'text-destructive', icon: AlertTriangle }
}

function lineCounts(file: GitChange): GitLineStats | undefined {
  const layers = [...(file.index !== '.' ? [file.stagedStats] : []), ...(file.worktree !== '.' ? [file.worktreeStats] : [])]
  const total = { added: 0, removed: 0, binary: false }
  for (const layer of layers) {
    if (!layer || layer.binary) return
    total.added += layer.added
    total.removed += layer.removed
  }
  if (total.added || total.removed) return total
}

export function fileTreeGitLabel(name: string, t: Translate, file?: GitChange) {
  if (!file) return {
    description: t('files.gitChangedFolder'),
    label: <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <MiddleEllipsis name={name} className="flex-1" />
      <span aria-hidden="true" data-file-tree-git="folder" className="grid size-4 shrink-0 place-items-center text-git-tree-folder"><span className="size-1.5 rounded-full bg-current" /></span>
    </span>
  }
  const status = file.conflict ? 'conflicted' : file.untracked ? 'untracked' : deleted(file) ? 'deleted' :
    file.index === 'A' ? 'added' : file.index === 'T' || file.worktree === 'T' ? 'typeChanged' : 'modified'
  const { color, icon: Icon } = marks[status]
  const counts = lineCounts(file)
  const countLength = counts ? [counts.added, counts.removed].reduce((length, count) => length + (count ? String(count).length + 1 : 0), 0) : 0
  // Reserve space for the filename and show each count in full when it fits.
  const showCounts = countLength > 16 ? '@min-[24em]/file-tree-label:inline-flex' :
    countLength > 8 ? '@min-[11em]/file-tree-label:inline-flex' : '@min-[8em]/file-tree-label:inline-flex'
  const description = t(`git.status.${status}`)
  return {
    description: counts ? `${description} · ${t('git.lineCounts', { added: counts.added, removed: counts.removed })}` : description,
    label: <span className="@container/file-tree-label flex min-w-0 flex-1">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <MiddleEllipsis name={name} className={cn('flex-1', color, status === 'deleted' && '[&>span]:line-through')} />
        {counts ? <span aria-hidden="true" className={cn('hidden shrink-0', showCounts)}><GitLineCounts stats={[counts]} compact /></span> : null}
        <Icon aria-hidden="true" data-file-tree-git={status} className={cn('size-4 shrink-0', color)} />
      </span>
    </span>
  }
}
