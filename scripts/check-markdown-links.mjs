/** A link destination containing spaces (`/Users/me/Library/Application
 * Support/...`) is not valid CommonMark, so it used to render as literal text
 * with no link. Assert the real parser stack produces the intended link with
 * the exact target, and that every candidate the normalizer cannot read
 * exactly keeps its original bytes. No model calls, no Electron. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repo = resolve(import.meta.dirname, '..')
const directory = await mkdtemp(join(tmpdir(), 'pith-markdown-links-'))
try {
  const helper = join(directory, 'links.mjs')
  await build({
    stdin: {
      contents: `
        import {unified} from 'unified';
        import remarkParse from 'remark-parse';
        import {REMARK_PLUGINS} from './src/renderer/src/lib/markdown-plugins';
        import {normalizeQuotedMath} from './src/renderer/src/lib/markdown-quoted-math';
        import {normalizeLinkSpaces} from './src/renderer/src/lib/markdown-link-spaces';
        import {splitMarkdownBlocks} from './src/renderer/src/lib/markdown-blocks';
        const parser = unified().use(remarkParse).use(REMARK_PLUGINS);
        // The component's own order: both normalizers rewrite the source text
        // before the parser sees it.
        export const repair = text => normalizeLinkSpaces(normalizeQuotedMath(text));
        export const parse = text => { const source = repair(text); return parser.runSync(parser.parse(source), source) };
        export const split = splitMarkdownBlocks;
      `,
      resolveDir: repo
    },
    outfile: helper,
    bundle: true,
    format: 'esm',
    platform: 'node',
    banner: { js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);" }
  })
  const { repair, parse, split } = await import(pathToFileURL(helper))

  /** Every link/image the source renders, in document order. */
  const links = (source) => {
    const found = []
    const visit = (node) => {
      if (node.type === 'link' || node.type === 'image') {
        found.push({
          type: node.type,
          url: node.url,
          title: node.title ?? null,
          label: node.type === 'link' ? (node.children ?? []).map((child) => child.value ?? '').join('') : node.alt
        })
      }
      for (const child of node.children ?? []) visit(child)
    }
    visit(parse(source))
    return found
  }
  const only = (source) => {
    const found = links(source)
    assert.equal(found.length, 1, 'exactly one link for ' + source)
    return found[0]
  }

  // The reported failure: an absolute macOS path with a space stayed literal.
  const spaced = only('[config.toml](/Users/example/Library/Application Support/rtk/config.toml)')
  assert.equal(spaced.type, 'link')
  assert.equal(spaced.label, 'config.toml')
  assert.equal(spaced.url, '/Users/example/Library/Application Support/rtk/config.toml')
  assert.deepEqual(
    only('[配置文件](/Users/me/Library/Application Support/rtk/config.toml)').url,
    '/Users/me/Library/Application Support/rtk/config.toml'
  )
  const image = only('![shot](/Users/me/My Documents/shot.png)')
  assert.equal(image.type, 'image')
  assert.equal(image.url, '/Users/me/My Documents/shot.png')
  assert.equal(image.label, 'shot')

  // A quoted title, tolerated surrounding whitespace and balanced parens stay
  // part of the link rather than becoming its address.
  assert.deepEqual(only('[a](/Users/me/My Docs/a.md "Notes")'), {
    type: 'link', url: '/Users/me/My Docs/a.md', title: 'Notes', label: 'a'
  })
  assert.equal(only('[a]( /Users/me/My Docs/a.md )').url, '/Users/me/My Docs/a.md')
  assert.equal(only('[a](/x (y) z)').url, '/x (y) z')
  assert.equal(only('[a](</Users/me/My Docs/a.md)').url, '/Users/me/My Docs/a.md', 'a missing bracket is closed')

  // Ordinary relative, Windows and in-prose positions; two links on one line;
  // a blockquote is content, not code.
  assert.equal(only('[doc](docs/Release Notes.md)').url, 'docs/Release Notes.md')
  assert.equal(only('[log](C:\\Users\\My Name\\log.txt)').url, 'C:\\Users\\My Name\\log.txt')
  assert.deepEqual(links('[a](/x y) and [b](/p q)').map((link) => link.url), ['/x y', '/p q'])
  assert.equal(only('> [a](/x y)').url, '/x y')

  // Code spans and blocks keep their exact bytes, and a link beside them is
  // still repaired — the transformation never leaks into what the user reads.
  const mixed = '`x\\ y` [a](/x y)'
  assert.equal(repair(mixed), '`x\\ y` [a](</x y>)')
  assert.equal(links('`[a](/x y)`').length, 0)
  assert.equal(links('```\n[a](/x y)\n```').length, 0)
  assert.equal(links('    [a](/x y)').length, 0, 'indented code')

  // Anything already valid, unreadable or merely prose-like stays untouched.
  const untouched = [
    '[a](/Users/me/My%20Docs/a.md)',
    '[a](</Users/me/My Docs/a.md>)',
    '[a](/Users/me/My\\ Docs/a.md)',
    '[a](see above)',
    '[a](/x y',
    '[a][ref]',
    '`[a](/x y)',
    'not a link at all'
  ]
  for (const source of untouched) assert.equal(repair(source), source, 'unchanged: ' + source)
  assert.equal(links('[a](/x y) [b](see above)').length, 1, 'prose beside a real link')

  // Rewriting is idempotent, and streaming prefixes never invent a link from an
  // incomplete candidate — a half-typed destination renders as it was typed.
  const rewritten = [
    '[config.toml](/Users/example/Library/Application Support/rtk/config.toml)',
    '![shot](/Users/me/My Documents/shot.png)',
    '[a](/x y) [b](/p q)',
    mixed
  ]
  for (const source of rewritten) assert.equal(repair(repair(source)), repair(source), 'stable: ' + source)
  const streaming = '全部完成：[config.toml](/Users/example/Library/Application Support/rtk/config.toml) 已安装'
  for (let end = 0; end <= streaming.length; end += 1) {
    const prefix = streaming.slice(0, end)
    assert.doesNotThrow(() => parse(prefix), 'streaming prefix ' + end)
    assert.equal(links(prefix).filter((link) => link.url.includes('<')).length, 0, 'no partial destination at ' + end)
  }
  assert.equal(only(streaming).url, '/Users/example/Library/Application Support/rtk/config.toml')
  // The transcript splits a streaming turn into blocks and normalizes each one,
  // so a link in the live tail must repair exactly like a complete message.
  assert.equal(repair(split('前言\n\n[a](/x y)').tail), '[a](</x y>)')

  console.log('PASS: link destinations with spaces become links on the real parser stack, while code, prose and already-valid or unfinished sources keep their bytes')
} finally {
  await rm(directory, { recursive: true, force: true })
}
