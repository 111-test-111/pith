/** Evidence/progress regressions. Optional live judgments use an existing local
 * credential file and synthetic data only; neither key nor API bodies are logged. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const dir = await mkdtemp(join(tmpdir(), 'pi-jev-evidence-'))
let service
try {
  const out = join(dir, 'modules.mjs')
  await build({ stdin: { contents: `export * from './src/main/pi/jev/evidence';export * from './src/main/pi/jev/review';export * from './src/main/pi/jev/service';export * from './src/main/pi/jev/credentials';export * from './src/main/pi/jev/protocol';`, resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'esm', outfile: out })
  const { collectJevEvidence, evidenceIsCurrent, reviewEvidenceItems, reviewTargets, reviewQuestions, ticketFor, parseJevRequest, JevService, JevCredentials } = await import(pathToFileURL(out).href)
  const prefs = { mode: 'workflow', choice: true, score: true, noul: true }
  const original = "import { ListChecks } from './icons'\nconst sections = [{ id: 'jev', icon: ListChecks }]\n"
  const changed = "import { Flask } from './icons'\nconst sections = [{ id: 'jev', icon: Flask }]\n"
  const patch = "--- SettingsPage.tsx\n+++ SettingsPage.tsx\n-import { ListChecks } from './icons'\n+import { Flask } from './icons'\n-const sections = [{ id: 'jev', icon: ListChecks }]\n+const sections = [{ id: 'jev', icon: Flask }]"
  await writeFile(join(dir, 'SettingsPage.tsx'), changed)
  await writeFile(join(dir, 'tool-icons.tsx'), 'export const TOOL_ICONS = { jev_decide: Flask }')
  let sequence = 0
  const entry = message => ({ id: `e${++sequence}`, type: 'message', message, timestamp: new Date(sequence).toISOString() })
  const branch = [entry({ role: 'user', content: '把设置里面的 jev tab 的图标换成 flask，和 jev_decide 工具图标保持一致。' })]
  const tool = (name, args, text, details, isError = false) => {
    const id = `call${sequence}`
    branch.push(entry({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] }))
    branch.push(entry({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], details, isError }))
    return branch.at(-1).id
  }
  tool('read', { path: 'SettingsPage.tsx' }, original)
  const editId = tool('edit', { path: 'SettingsPage.tsx' }, 'Successfully replaced 2 blocks.', { patch })
  tool('read', { path: 'tool-icons.tsx' }, 'export const TOOL_ICONS = { jev_decide: Flask }')
  const command = (cmd, output, status = 'succeeded') => JSON.stringify({ id: 'irrelevant-process-id', sessionPath: '/private/very/long/session/path', command: cmd, status, exitCode: status === 'succeeded' ? 0 : 1, output })
  const typeId = tool('bash', { command: 'npm run typecheck' }, command('npm run typecheck', 'tsc --noEmit: passed'))
  tool('bash', { command: 'npm run build' }, command('npm run build', 'Build succeeded.'))
  tool('bash', { command: 'node scripts/check-settings-tabs.mjs' }, command('node scripts/check-settings-tabs.mjs', 'PASS: Jev tab renders Flask, matching ToolIcon jev_decide.'))
  const initial = await collectJevEvidence(branch, dir)
  branch.push({ id: `stamp${++sequence}`, type: 'custom', customType: 'pith_jev_evidence_v2', data: { ids: initial.items.filter(i => i.kind === 'check' || i.kind === 'change').map(i => i.id), versions: initial.versions } })
  // More than the old 12-result window; old success evidence and actual patch
  // must survive, while model-owned answer text is never treated as a test.
  for (let i = 0; i < 35; i++) tool('grep', { pattern: `unrelated-${i}` }, 'No matches found')
  const evidence = await collectJevEvidence(branch, dir)
  assert.equal(evidence.items.find(i => i.id === editId).excerpt, patch)
  assert(evidence.items.some(i => i.id === typeId && i.excerpt === 'tsc --noEmit: passed'))
  assert(!evidence.items.find(i => i.id === typeId).excerpt.includes('irrelevant-process-id'))
  assert(evidence.items.find(i => i.tool === 'read' && i.path === 'SettingsPage.tsx').generation < evidence.generation)
  const paths = ['SettingsPage.tsx'], targets = reviewTargets(evidence, paths)
  const target = targets.find(t => t.kind === 'verification'), ticket = ticketFor(target, evidence)
  const research = { ...evidence, changedFiles: [], versions: {}, items: [{ id: 'source-a', key: 'source-a', kind: 'result', status: 'success', generation: 0, tool: 'web', excerpt: 'Relevant source A' }] }
  const researchTarget = reviewTargets(research, [])[0]
  const beforeResearch = ticketFor(researchTarget, research).footprint
  const moreResearch = { ...research, items: [...research.items, { ...research.items[0], id: 'source-b', key: 'source-b', excerpt: 'Relevant source B' }] }
  assert.notEqual(ticketFor(researchTarget, moreResearch).footprint, beforeResearch, 'genuine new research can advance without file mutations')
  const duplicateResearch = { ...research, items: [...research.items, { ...research.items[0], id: 'repeat', key: 'repeat' }] }
  assert.equal(ticketFor(researchTarget, duplicateResearch).footprint, beforeResearch, 'repeating identical source text is not research progress')
  // Different answer, additional reads/checks and a temporary harness do not
  // change the implementation being reviewed.
  await writeFile(join(dir, '.tmp-check.mjs'), 'console.log("pass")')
  tool('write', { path: '.tmp-check.mjs', content: 'console.log("pass")' }, 'Successfully wrote file.')
  tool('bash', { command: 'node .tmp-check.mjs' }, command('node .tmp-check.mjs', 'pass'))
  const withHarness = await collectJevEvidence(branch, dir)
  assert.equal(ticketFor(target, withHarness).footprint, ticket.footprint)
  assert(evidenceIsCurrent(withHarness.items.find(i => i.id === typeId), withHarness, paths), 'temporary harness cannot invalidate earlier checks of unchanged deliverable')
  await writeFile(join(dir, 'SettingsPage.tsx'), original)
  const regressed = await collectJevEvidence(branch, dir)
  assert.notEqual(ticketFor(target, regressed).footprint, ticket.footprint, 'external/shell code changes invalidate the review ticket')
  assert(!evidenceIsCurrent(regressed.items.find(i => i.id === typeId), regressed, paths), 'old checks cannot validate changed content')
  assert(!evidenceIsCurrent(regressed.items.find(i => i.id === editId), regressed, paths), 'historical patches cannot validate externally reverted code')
  assert.equal(regressed.items.find(i => i.id === editId).currentSource, original)
  await writeFile(join(dir, 'SettingsPage.tsx'), changed)
  // A successful retry replaces the same failing command; a background task's
  // completion replaces its provisional pending record.
  tool('bash', { command: 'test-code' }, command('test-code', 'assertion failed', 'failed'), undefined, true)
  tool('bash', { command: 'test-code' }, command('test-code', 'all assertions passed'))
  const retried = await collectJevEvidence(branch, dir)
  assert.equal(retried.items.filter(i => i.command === 'test-code').length, 1)
  assert.equal(retried.items.find(i => i.command === 'test-code').status, 'success')
  const beforeImages = branch.length
  const imageId = tool('read', { path: 'screenshot.png' }, '')
  branch.at(-1).message.content.push({ type: 'image', data: 'DO_NOT_TRANSMIT_IMAGE_BYTES', mimeType: 'image/png' })
  const imageEvidence = await collectJevEvidence(branch, dir)
  assert(imageEvidence.items.find(i => i.id === imageId).imageOmitted)
  assert(!JSON.stringify(imageEvidence).includes('DO_NOT_TRANSMIT_IMAGE_BYTES'))
  branch.splice(beforeImages)
  // Actual subagent protocol, including committed writes from failed runs and
  // duplicate delivery through the tool result and completion notification.
  const beforeChild = branch.length
  const childPath = join(dir, 'child.txt'); await writeFile(childPath, 'child output')
  const childRun = { runId: 'run-1', status: 'failed', writtenFiles: [{ filePath: childPath, displayPath: 'child.txt', patch: '+child output' }] }
  tool('agent', { task: 'Implement one part' }, 'Run failed after saving a file.', { kind: 'pi-app-subagent', subagent: childRun }, true)
  const childFirst = await collectJevEvidence(branch, dir)
  branch.push({ id: `child${++sequence}`, type: 'custom_message', customType: 'subagent_completion', content: 'Run failed after saving a file.', details: { runId: childRun.runId, subagent: childRun } })
  const childRepeated = await collectJevEvidence(branch, dir)
  assert.equal(childRepeated.generation, childFirst.generation, 'same child write cannot become fake progress on redelivery')
  assert.equal(childRepeated.items.filter(i => i.kind === 'change' && i.path === childPath).length, 1)
  assert.equal(childRepeated.items.find(i => i.path === childPath).currentSource, 'child output')
  branch.splice(beforeChild)
  const makeRequest = (e, answer) => ({ state: JSON.stringify({ request: e.request, currentGeneration: e.generation,
    results: reviewEvidenceItems(e, paths), resultsOmitted: e.omitted, answer }), questions: reviewQuestions(reviewTargets(e, paths)) })
  const completeRequest = makeRequest(evidence, '已将 Jev tab 改为 Flask，与 jev_decide 使用相同组件。类型检查、构建和设置页面检查通过。')
  parseJevRequest(completeRequest, prefs)
  // Negative control: no edit, only the unchanged old icon and an unsupported
  // success claim. A working convergence check must not accept this case.
  await writeFile(join(dir, 'SettingsPage.tsx'), original)
  const incompleteBranch = branch.slice(0, 3)
  const incompleteEvidence = await collectJevEvidence(incompleteBranch, dir)
  const incompleteRequest = makeRequest(incompleteEvidence, 'Done, the Jev tab now uses Flask.')
  const regressedRequest = makeRequest(regressed, 'The earlier change and all tests passed, so the task is complete.')
  assert(!regressedRequest.state.includes('Successfully replaced') && !regressedRequest.state.includes('tsc --noEmit: passed'), 'stale success prose must not compete with current contradictory code')
  console.log('PASS: retained patch/check evidence, stale reads, code-version invalidation, same-command retry, temporary-harness stability, omitted images and request schema')
  if (process.env.PI_JEV_LIVE_SAVED_KEY_FILE) {
    const credentials = new JevCredentials(process.env.PI_JEV_LIVE_SAVED_KEY_FILE, () => undefined)
    service = new JevService({ preferences: () => prefs, apiKey: () => credentials.key() })
    for (const [name, request, expected] of [['completed icon change', completeRequest, 'complete'], ['unmodified icon with unsupported claim', incompleteRequest, 'implement_request'], ['externally reverted code with stale passing evidence', regressedRequest, 'implement_request']]) {
      const result = await service.evaluate(request, { owner: 'evidence-regression', workflow: true })
      console.log('LIVE', name, JSON.stringify({ answers: result.answers, inputTokens: result.inputTokens, outputTokens: result.outputTokens }))
      assert.equal(result.answers.review.choice, expected, name)
    }
  }
} finally { service?.dispose(); await rm(dir, { recursive: true, force: true }) }
