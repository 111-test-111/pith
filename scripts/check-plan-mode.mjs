/** Plan Mode Task 1 checks: protocol fold, durable storage boundary, offline fixture. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

import { createPlanFixture } from './lib/plan-fixture.mjs'

const cwd = resolve('/Users/jcy/githubs/pi-app/.worktrees/plan-mode')
const temporary = await mkdtemp(join(tmpdir(), 'pith-plan-mode-'))
const agentDir = join(temporary, 'agent')
const project = join(temporary, 'project')
const sessions = join(temporary, 'sessions')
const userData = join(temporary, 'userData')

const sdk = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const outfile = join(temporary, 'modules.mjs')

await mkdir(agentDir)
await mkdir(project)
await mkdir(sessions)
await mkdir(userData)

await build({
  stdin: {
    contents: `export { PiManager } from './src/main/pi/manager';
export { PlanStorage } from './src/main/pi/plan-storage';
export * from './src/main/pi/plan-protocol';
export { SessionManager, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';`,
    resolveDir: cwd
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  plugins: [{
    name: 'isolated-profile',
    setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'sdk', namespace: 'fixture' }))
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onResolve({ filter: /^playwright-core(\/|$)|^chromium-bidi(\/|$)/ }, (args) => {
        const resolved = fileURLToPath(import.meta.resolve(args.path))
        return { path: resolved, external: true }
      })
      builder.onResolve({ filter: /^\// }, (args) => args.path === sdk ? { path: sdk, external: true } : undefined)
      builder.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({
        contents: `export const app={getPath:(key)=>{
          if (key==='userData') return ${JSON.stringify(userData)};
          throw new Error('unexpected getPath '+key);
        }};export const shell={};`
      }))
      builder.onLoad({ filter: /^sdk$/, namespace: 'fixture' }, () => ({
        contents: `
export * from ${JSON.stringify(sdk)};
import {createAgentSessionServices as create,SettingsManager} from ${JSON.stringify(sdk)};
export const getAgentDir=()=>${JSON.stringify(agentDir)};
export function createAgentSessionServices(options){
  return create({
    ...options,
    agentDir:getAgentDir(),
    settingsManager:SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}}),
    resourceLoaderOptions:{
      ...options.resourceLoaderOptions,
      noExtensions:true,
      noSkills:true,
      noPromptTemplates:true,
      noThemes:true,
      noContextFiles:true,
      extensionFactories:[...(options.resourceLoaderOptions.extensionFactories??[])]
    }
  });
};`
      }))
    }
  }]
})

const {
  PLAN_MODE_ENTRY,
  PLAN_APPROVAL_ENTRY,
  PLAN_SUBMISSION_KIND,
  reconstructPlan,
  isCurrentPlan,
  parsePlanSubmission,
  PlanStorage,
  SessionManager,
  ModelRuntime,
  PiManager,
  SettingsManager
} = await import(pathToFileURL(outfile).href)

// ---------------------------------------------------------------------------
// Step 1/2: protocol red/green checks
// ---------------------------------------------------------------------------

assert.equal(reconstructPlan([]).mode, 'normal')

const enter = {
  id: 'm1',
  type: 'custom',
  customType: PLAN_MODE_ENTRY,
  data: { version: 1, mode: 'plan', planId: 'p1', via: 'toggle' }
}
const user = {
  id: 'u1',
  type: 'message',
  message: { role: 'user', content: 'Design it' }
}
const details = {
  kind: PLAN_SUBMISSION_KIND,
  version: 1,
  planId: 'p1',
  revision: 1,
  planningTurnEntryId: 'u1',
  plan: '# Plan\nRead, then change.',
  hash: 'a'.repeat(64)
}
const result = {
  id: 's1',
  type: 'message',
  message: {
    role: 'toolResult',
    toolName: 'submit_plan',
    toolCallId: 'tc1',
    isError: false,
    details,
    timestamp: 1000
  }
}

const state = reconstructPlan([enter, user, result])
assert.equal(state.latest.ref.submissionEntryId, 's1')
assert.equal(isCurrentPlan(state), true)
assert.equal(isCurrentPlan(reconstructPlan([enter, user, result, { ...user, id: 'u2' }])), false)
assert.equal(parsePlanSubmission({ ...result.message, isError: true }), null)

// Additional invalid input/version checks for parsePlanSubmission.
assert.equal(parsePlanSubmission({ ...result.message, details: { ...details, version: 2 } }), null)
assert.equal(parsePlanSubmission({ ...result.message, details: { ...details, revision: 0 } }), null)
assert.equal(parsePlanSubmission({ ...result.message, details: { ...details, plan: '' } }), null)
assert.equal(parsePlanSubmission({ ...result.message, details: { ...details, hash: 'abc' } }), null)
assert.equal(parsePlanSubmission({ ...result.message, toolName: 'bash' }), null)

// Different planId or mismatched turn must not be treated as current in reconstructPlan.
const wrongPlan = {
  ...result,
  message: {
    ...result.message,
    details: { ...details, planId: 'p2' }
  }
}
assert.equal(reconstructPlan([enter, user, wrongPlan]).latest, null)
const wrongTurn = {
  ...result,
  message: {
    ...result.message,
    details: { ...details, planningTurnEntryId: 'u2' }
  }
}
assert.equal(isCurrentPlan(reconstructPlan([enter, user, wrongTurn])), false)

const enterUnsupported = {
  id: 'm2',
  type: 'custom',
  customType: PLAN_MODE_ENTRY,
  data: { version: 99, mode: 'plan', planId: 'p1', via: 'toggle' }
}
assert.equal(reconstructPlan([enterUnsupported]).unsupported, true)
assert.equal(reconstructPlan([enterUnsupported]).mode, 'normal')

const approval = {
  id: 'a1',
  type: 'custom',
  customType: PLAN_APPROVAL_ENTRY,
  data: {
    version: 1,
    approvalId: 'ap1',
    ref: state.latest.ref,
    status: 'requested'
  }
}
const approvedState = reconstructPlan([enter, user, result, approval])
assert.equal(approvedState.approval?.approvalId, 'ap1')
assert.equal(approvedState.approval?.status, 'requested')

console.log('PASS: protocol fold/parser')

// ---------------------------------------------------------------------------
// Step 3: PlanStorage durable boundary
// ---------------------------------------------------------------------------

const storageManager = SessionManager.create(project, sessions)
const storageFile = join(sessions, 'storage-test.jsonl')
storageManager.setSessionFile(storageFile)
// Materialize the session file so appendCustomEntry + fsync have a target.
const header = storageManager.getHeader()
if (header) {
  await mkdir(sessions, { recursive: true })
  await writeFile(storageFile, `${JSON.stringify(header)}\n`, { flag: 'wx' })
}
const planStorage = new PlanStorage(storageManager)
const customId = planStorage.append(PLAN_MODE_ENTRY, { version: 1, mode: 'plan', planId: 'p2', via: 'toggle' })
assert.equal(typeof customId, 'string')
assert.equal(planStorage.failed, false)

// Simulate a post-append fsync failure by corrupting the latch manually.
planStorage.failed = true
assert.throws(() => planStorage.append(PLAN_APPROVAL_ENTRY, {}), /plan-storage-locked/)

console.log('PASS: PlanStorage latch')

// ---------------------------------------------------------------------------
// Step 4/5: real SDK fixture
// ---------------------------------------------------------------------------

const fixture = await createPlanFixture({
  respond: () => [{ type: 'text', text: 'Hello from fixture' }]
})
assert.equal(typeof fixture.session.sessionId, 'string')
assert.equal(fixture.session.isIdle, true)
assert.equal(fixture.requests.length, 0)

await fixture.session.prompt('Say hello')
assert.equal(fixture.requests.length, 1)
assert.equal(fixture.store.getState().messages.some((m) => m.role === 'assistant'), true)
assert.equal(fixture.store.getState().messages.some((m) => m.role === 'user'), true)

await fixture.close()

console.log('PASS: real SDK fixture constructs, sends fake turn and closes')

await rm(temporary, { recursive: true, force: true })
console.log('PASS: all plan-mode checks')
