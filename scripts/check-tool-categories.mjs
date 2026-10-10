/**
 * Transcript tool-category regression check. Namespaced context-mode,
 * embedded-browser and MCP calls must each form their own maximal adjacent
 * run. Codemode and tool search remain standalone; historical adapter names
 * keep their old category. Pure: no Electron, model calls
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
  assert.equal(toolCategory('mcp')?.id, 'mcp', 'historical gateway calls stay grouped')
  assert.equal(toolCategory('mcpScript')?.id, 'mcp', 'historical scripting calls stay grouped')
  assert.equal(toolCategory('mcp__beui')?.id, 'mcp', 'historical server proxy calls stay grouped')
  assert.equal(toolCategory('mcp__beui__get_component')?.id, 'mcp', 'native server tools join MCP')
  assert.equal(toolCategory('list_mcp_resources')?.id, 'mcp', 'resource listing joins MCP')
  assert.equal(toolCategory('list_mcp_resource_templates')?.id, 'mcp', 'resource templates join MCP')
  assert.equal(toolCategory('read_mcp_resource')?.id, 'mcp', 'resource reads join MCP')
  assert.equal(isMcpTool('mcp__future_server__future_tool'), true, 'a new native tool joins MCP')
  assert.equal(isMcpTool('mcpX'), false, 'a name that merely starts with mcp is not one')
  assert.equal(isMcpTool('codemode'), false, 'codemode does not inherit MCP grouping or permission')
  assert.equal(isMcpTool('tool_search'), false, 'tool search does not inherit MCP grouping or permission')
  assert.equal(toolCategory('codemode'), undefined, 'codemode owns a standalone transcript row')
  assert.equal(toolCategory('tool_search'), undefined, 'tool search owns a standalone transcript row')
  assert.equal(toolCategory('other_tool'), undefined)

  assert.deepEqual(splitByToolCategory(['edit', 'write', 'image', 'image', 'write', 'edit'].map(name => ({ name })))
    .map(run => [run.category?.id, run.items.map(call => call.name)]), [
      ['changes', ['edit', 'write']], [undefined, ['image']], [undefined, ['image']], ['changes', ['write', 'edit']]
    ], 'image calls remain independent and separate neighbouring Changes groups')

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
    { id: 'm4', name: 'mcp__context7' },
    { id: 'm5', name: 'mcp__beui__get_component' },
    { id: 'm6', name: 'list_mcp_resources' },
    { id: 's1', name: 'codemode' },
    { id: 's2', name: 'tool_search' }
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
      ['mcp', ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']],
      [undefined, ['s1']],
      [undefined, ['s2']]
    ]
  )

  console.log('PASS: declared tool families group adjacent calls; image, codemode and tool search stay independent.')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
