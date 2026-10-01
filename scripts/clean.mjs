/** Remove project-generated outputs without deleting installed dependencies. */
import { readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const outputs = [
  'out', 'dist', '.vite', '.test-results', 'node_modules/.vite', 'node_modules/.vite-temp',
  'src/renderer/public/file-icons'
]
for (const entry of await readdir(root)) {
  if (entry.endsWith('.tsbuildinfo')) outputs.push(entry)
}
for (const variant of ['base', 'with-dap', 'without-dap']) {
  for (const binary of ['ledger', 'index_test']) {
    outputs.push(`scripts/debug-fixtures/dap-comparison/${variant}/${binary}`)
    outputs.push(`scripts/debug-fixtures/dap-comparison/${variant}/${binary}.dSYM`)
  }
}
for (const output of outputs) await rm(join(root, output), { recursive: true, force: true })
console.log('Cleaned build outputs, generated icons and development caches.')
