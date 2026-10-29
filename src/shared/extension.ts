/**
 * The one place a path is split into an extension.
 *
 * `media.ts`, `table.ts` and `preview.ts` each own their own extension tables,
 * and they have to agree on what `.PNG` or a dotfile means — a second copy of
 * this rule is how a `.TSV` ends up a table in one module and text in another.
 *
 * Returns the extension lower-cased and including its dot. `''` for a name
 * without one, and for a leading-dot name: `.env` is a name, not an `.env`
 * extension, which is what keeps dotfiles out of every extension table.
 */
export function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}
