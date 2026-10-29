import { ARCHIVE_MAX_ENTRIES, type ArchiveEntry } from '../../../shared/file-preview'

export interface ArchiveTreeNode {
  key: string
  name: string
  path: string
  children?: ArchiveTreeNode[]
  entry?: ArchiveEntry
}

/** Implicit parent directories and explicit directory entries share a branch.
 * Preserve duplicate file entries by ordinal, and bound synthetic directories
 * and depth; exceptionally deep paths remain visible as a single path label. */
export function archiveTree(entries: readonly ArchiveEntry[], query: string): { roots: ArchiveTreeNode[]; expanded: string[] } {
  const roots: ArchiveTreeNode[] = [], folders = new Map<string, ArchiveTreeNode>()
  const needle = query.toLocaleLowerCase()
  for (const entry of entries) {
    const path = entry.name.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/\/+/g, '/').replace(/\/$/, '')
    if (!path || needle && !path.toLocaleLowerCase().includes(needle)) continue
    const parts = path.split('/')
    let children = roots, prefix = '', depth = 0
    for (; depth < parts.length - 1; depth++) {
      const parent = prefix + parts[depth]
      let folder = folders.get(parent)
      if (!folder && (depth >= 32 || folders.size >= ARCHIVE_MAX_ENTRIES)) break
      if (!folder) {
        folder = { key: 'folder:' + parent, name: parts[depth], path: parent, children: [] }
        folders.set(parent, folder); children.push(folder)
      }
      children = folder.children!; prefix = parent + '/'
    }
    if (entry.kind === 'directory') {
      if (!folders.has(path)) {
        const folder = { key: 'folder:' + path, name: parts.slice(depth).join('/'), path, children: [] }
        folders.set(path, folder); children.push(folder)
      }
    } else children.push({ key: entry.id, name: parts.slice(depth).join('/'), path, entry })
  }
  const sort = (nodes: ArchiveTreeNode[]) => {
    nodes.sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const node of nodes) if (node.children) sort(node.children)
  }
  sort(roots)
  return { roots, expanded: [...folders.values()].filter(folder => folder.children!.length > 0).map(folder => folder.key) }
}
