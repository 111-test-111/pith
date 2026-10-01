/** Apply the Pi bridge to an already installed official skill; no network or credentials. */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const start = '<!-- pi-app:native-bridge:start -->'
const end = '<!-- pi-app:native-bridge:end -->'
const discovery = '  In Pi, also use for bounded Jev judgments via the native jev_decide tool when available.\n'
const bridge = `${start}
## Pi app: choose the task path

This installation includes a local Pi app adaptation; the official guidance remains below.

- **Judge evidence in the current Pi task:** if the active tools include \`jev_decide\`, read [the native Pi contract and examples](references/pi-app.md) and use that tool. Its live description lists enabled question types. The tool owns credentials and transport. Ordinary native calls use this contract and the tool schema; they do not require the SDK-installation or live-docs workflow below.
- **Build or change a TypeSafe integration in the user's project:** follow the official live-docs and SDK guidance below. Preserve the user's language and stack. Calling Pi's tool may help validate a judgment, but does not implement the user's application.
- **Enforced workflow:** when the app supplies workflow instructions, follow that controller and its concrete target. Preserve the original requested scope, reuse passing checks on unchanged code, and do not invent extra acceptance criteria. If the target is already supported, cite the evidence instead of repeating checks; report an actual blocker when no useful progress is possible. The optional native tool is intentionally hidden. Do not duplicate routing/verification or bypass a paused workflow using SDK/shell calls. Children execute their assigned task without recursive Jev controllers.
- **Native tool missing or a type disabled:** the skill grants no extra capability. Continue with the available tools, and point to Settings → Jev when relevant. Do not read Pi credentials, install an extension, or run an ad hoc API script to bypass the native setting. Explicit SDK-development tasks still use their own requested setup.

Keep exact calculations, source retrieval, tests, permissions and execution in code. Use Jev for the bounded semantic judgment that remains.
${end}`

export async function adaptTypesafeSkill(directory) {
  const path = join(directory, 'SKILL.md')
  let source = await readFile(path, 'utf8')
  if (!/^name: typesafe-ai\s*$/m.test(source) || !source.includes('# Build with TypeSafe')) throw new Error('Expected the official typesafe-ai SKILL.md')
  // A reapply replaces only our marked section; keep any unrelated local edits.
  const first = source.indexOf(start), last = source.indexOf(end)
  if ((first >= 0) !== (last >= 0) || (first >= 0 && last < first)) throw new Error('Incomplete Pi bridge markers; review the skill before adapting')
  if (first >= 0) source = source.slice(0, first).replace(/\n$/, '') + source.slice(last + end.length).replace(/^\n/, '')
  source = source.replace(discovery, '')
  if (!/^description: >\s*$/m.test(source)) throw new Error('Upstream description format changed; review before adapting')
  // Keep the first pre-adaptation copy for review; it is hidden from Pi discovery.
  await writeFile(join(directory, '.pi-app-original.md'), source, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const adapted = source.replace(/^(description: >\s*\n)/m, `$1${discovery}`)
    .replace('# Build with TypeSafe\n', `# Build with TypeSafe\n\n${bridge}\n`)
  await mkdir(join(directory, 'references'), { recursive: true })
  await copyFile(new URL('../docs/jev-tool-reference.md', import.meta.url), join(directory, 'references/pi-app.md'))
  await writeFile(path, adapted)
  return path
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/adapt-typesafe-skill.mjs <installed skill directory>')
  console.log(`Adapted ${await adaptTypesafeSkill(resolve(process.argv[2]))}`)
}
