/**
 * Transcript tool-category regression check. Namespaced context-mode,
 * embedded-browser and MCP calls must each form their own maximal adjacent
 * run, while unknown names remain standalone. Pure: no Electron, model calls
 * or network.
 */
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(repo, 'node_modules', '.cache', 'pith-tool-categories')

try {
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const bundle = join(scratch, 'tool-categories.mjs')
  await build({
    entryPoints: [join(repo, 'src/renderer/src/lib/tool-categories.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    alias: { '@': join(repo, 'src/renderer/src') },
    outfile: bundle
  })

  const { splitByToolCategory, toolCategory, isMcpTool } = await import(bundle)

  assert.equal(toolCategory('ctx_execute')?.id, 'context')
  assert.equal(toolCategory('ctx_future_tool')?.id, 'context', 'new ctx_* tools join the context group')
  assert.equal(toolCategory('browser_navigate')?.id, 'browser')
  assert.equal(toolCategory('browser_future_tool')?.id, 'browser', 'new browser_* tools join the browser group')
  assert.equal(toolCategory('mcp')?.id, 'mcp', 'the gateway is part of the MCP family')
  assert.equal(toolCategory('mcpScript')?.id, 'mcp', 'so is the scripting wrapper')
  assert.equal(toolCategory('mcp__beui')?.id, 'mcp', 'every per-server proxy joins the MCP family')
  assert.equal(isMcpTool('mcp__future_server'), true, 'a server added later still joins the MCP family')
  assert.equal(isMcpTool('mcpX'), false, 'a name that merely starts with mcp is not one')
  assert.equal(toolCategory('other_tool'), undefined)

  const calls = [
    { id: 'c1', name: 'ctx_execute' },
    { id: 'c2', name: 'ctx_search' },
    { id: 'b1', name: 'browser_navigate' },
    { id: 'b2', name: 'browser_click' },
    { id: 'c3', name: 'ctx_index' },
    { id: 'r1', name: 'read' },
    { id: 'g1', name: 'grep' },
    { id: 'u1', name: 'other_tool' },
    { id: 'u2', name: 'other_tool' },
    { id: 'm1', name: 'mcp' },
    { id: 'm2', name: 'mcpScript' },
    { id: 'm3', name: 'mcp__beui' },
    { id: 'm4', name: 'mcp__context7' }
  ]
  const runs = splitByToolCategory(calls)

  assert.deepEqual(
    runs.map((run) => [run.category?.id, run.items.map((call) => call.id)]),
    [
      ['context', ['c1', 'c2']],
      ['browser', ['b1', 'b2']],
      ['context', ['c3']],
      ['exploration', ['r1', 'g1']],
      [undefined, ['u1']],
      [undefined, ['u2']],
      ['mcp', ['m1', 'm2', 'm3', 'm4']]
    ]
  )

  console.log('PASS: consecutive ctx_*, browser_* and MCP calls each form their own transcript group.')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
