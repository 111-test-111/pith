// node-pty 1.1's published macOS prebuild may lose the helper's executable bit.
// Keep installs and packaged asar-unpacked copies runnable without runtime chmod.
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
const require = createRequire(import.meta.url)
if (process.platform === 'darwin') {
  const root = dirname(require.resolve('node-pty/package.json'))
  for (const directory of ['build/Release', 'build/Debug', 'prebuilds/darwin-arm64', 'prebuilds/darwin-x64']) {
    const helper = join(root, directory, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
