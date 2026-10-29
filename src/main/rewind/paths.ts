/** Paths here are validated, slash-separated workspace paths. Segment sets
 * avoid a protected-path × tracked-file scan in large dependency trees. */
export class PathIndex {
  private exact: Set<string>
  private ancestors = new Set<string>()
  constructor(paths: Iterable<string>) {
    this.exact = new Set(paths)
    for (const path of this.exact) {
      for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) this.ancestors.add(path.slice(0, slash))
    }
  }
  contains(path: string): boolean {
    if (this.exact.has(path)) return true
    for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) if (this.exact.has(path.slice(0, slash))) return true
    return false
  }
  atOrBelow(path: string): boolean { return this.exact.has(path) || this.ancestors.has(path) }
  overlaps(path: string): boolean { return this.ancestors.has(path) || this.contains(path) }
}
