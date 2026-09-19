/** Plan Mode Task 1 checks: protocol fold, durable storage boundary, offline fixture. */
import assert from 'node:assert/strict'
import { chmodSync, readFileSync } from 'node:fs'
import { copyFile, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

import { createPlanFixture, planRepoRoot } from './lib/plan-fixture.mjs'

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

// ---------------------------------------------------------------------------
// Portability: the repo root follows each script's own location, never cwd or
// a path baked in for one machine/worktree.
// ---------------------------------------------------------------------------
const portableDir = await mkdtemp(join(tmpdir(), 'pith-plan-portable-'))
try {
  await mkdir(join(portableDir, 'scripts', 'lib'), { recursive: true })
  // Keep bare-specifier resolution working for the relocated copy.
  await symlink(join(planRepoRoot, 'node_modules'), join(portableDir, 'node_modules'), 'dir')
  await copyFile(
    fileURLToPath(new URL('./lib/plan-fixture.mjs', import.meta.url)),
    join(portableDir, 'scripts', 'lib', 'plan-fixture.mjs')
  )
  const relocated = await import(pathToFileURL(join(portableDir, 'scripts', 'lib', 'plan-fixture.mjs')).href)
  assert.equal(await realpath(relocated.planRepoRoot), await realpath(portableDir))
} finally {
  await rm(portableDir, { recursive: true, force: true })
}

console.log('PASS: repo root resolves from the script location, not a baked path')

await build({
  stdin: {
    contents: `export { PiManager } from './src/main/pi/manager';
export { PlanController } from './src/main/pi/plan-mode';
export { PlanStorage } from './src/main/pi/plan-storage';
export * from './src/main/pi/plan-protocol';
export { PLAN_MAX_BYTES } from './src/shared/plan';
export { SessionManager, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';`,
    resolveDir: planRepoRoot
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
  PLAN_MAX_BYTES,
  PLAN_MODE_ENTRY,
  PLAN_APPROVAL_ENTRY,
  PLAN_SUBMISSION_KIND,
  reconstructPlan,
  isCurrentPlan,
  parsePlanSubmission,
  PlanController,
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

// The persisted toolResult body is authoritative: trimming decides emptiness
// only, and the original bytes are what get stored and hashed.
const paddedPlan = '\n\n# Plan\nRead, then change.\n\n'
const paddedResult = {
  ...result,
  message: { ...result.message, details: { ...details, plan: paddedPlan } }
}
assert.equal(parsePlanSubmission(paddedResult.message)?.plan, paddedPlan)
assert.equal(reconstructPlan([enter, user, paddedResult]).latest.markdown, paddedPlan)

// The bound measures the raw submitted UTF-8 bytes, not a trimmed body whose
// whitespace padding still crossed the limit.
const paddedOverLimit = `${' '.repeat(PLAN_MAX_BYTES)}é`
assert.equal(Buffer.byteLength(paddedOverLimit.trim(), 'utf8') <= PLAN_MAX_BYTES, true)
assert.equal(
  parsePlanSubmission({ ...result.message, details: { ...details, plan: paddedOverLimit } }),
  null
)

// A submission with no persisted entry ID has no authoritative source: skip it,
// and never fabricate an identity that changes between folds.
const noIdResult = { ...result, id: undefined }
assert.equal(reconstructPlan([enter, user, noIdResult]).latest, null)
assert.equal(reconstructPlan([enter, user, { ...result, id: '   ' }]).latest, null)
const firstFold = reconstructPlan([enter, user, noIdResult])
assert.deepEqual(reconstructPlan([enter, user, noIdResult]), firstFold)

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

// ---------------------------------------------------------------------------
// Task 2: session mode, admission reservations and live metadata
// ---------------------------------------------------------------------------

const baseFacts = (overrides = {}) => ({
  initializing: false,
  closing: false,
  child: false,
  recovery: false,
  sdkIdle: true,
  tasks: 0,
  subagents: 0,
  deliveries: 0,
  questions: 0,
  escalations: 0,
  queuedMessages: 0,
  configuredSandboxMode: 'danger-full-access',
  inheritedPlanRestriction: false,
  shellEnforcement: 'full',
  ...overrides
})

async function until(check, message, timeoutMs = 10_000) {
  const started = Date.now()
  while (!check() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(check(), true, message)
}

/** Wait out a fixture turn: its model call happened and nothing is still running. */
async function settled(fixture, requests) {
  await until(
    () => fixture.requests.length === requests && fixture.session.isIdle && fixture.managed.lifecyclePromise === null,
    `fixture turn #${requests} did not settle`
  )
}

/** Wait out session initialization (extension startup) before a mode switch. */
async function planReady(fixture) {
  await until(
    () => !fixture.managed.initializing && fixture.managed.lifecyclePromise === null,
    'fixture session did not finish initializing'
  )
}

const branchIds = (manager) => manager.getBranch().map((entry) => entry.id)

// -- admission facts table over a real SessionManager ------------------------

const unitDir = join(temporary, 'unit')
await mkdir(unitDir, { recursive: true })
const unitManager = SessionManager.create(project, unitDir)
const unitFile = join(unitDir, 'admission.jsonl')
unitManager.setSessionFile(unitFile)
await writeFile(unitFile, `${JSON.stringify(unitManager.getHeader())}\n`, { flag: 'wx' })

const facts = baseFacts()
let publishes = 0
let clock = 0
const controller = new PlanController({
  manager: unitManager,
  storage: new PlanStorage(unitManager),
  facts: () => facts,
  changed: () => { publishes += 1 },
  nextSeq: () => ++clock
})

assert.equal(controller.branch.mode, 'normal')
assert.equal(controller.restricted, false)
assert.equal(controller.transitionBusy, false)
assert.equal(controller.submissionLocked, false)
assert.equal(controller.snapshot.mode, 'normal')
assert.equal(controller.snapshot.effectiveSandboxMode, 'danger-full-access')
assert.equal(controller.snapshot.configuredSandboxMode, 'danger-full-access')
assert.deepEqual(controller.snapshot.blockers.switch, [])

const admissionCases = [
  ['initializing', { initializing: true }],
  ['closing', { closing: true }],
  ['child-session', { child: true }],
  ['recovery', { recovery: true }],
  ['busy', { sdkIdle: false }],
  ['tasks', { tasks: 1 }],
  ['subagents', { subagents: 1 }],
  ['deliveries', { deliveries: 1 }],
  ['questions', { questions: 1 }],
  ['escalations', { escalations: 1 }],
  ['queued-messages', { queuedMessages: 1 }]
]
for (const [code, overrides] of admissionCases) {
  Object.assign(facts, baseFacts(), overrides)
  const before = JSON.stringify(branchIds(unitManager))
  let ran = false
  await assert.rejects(
    controller.transition(async () => { ran = true }),
    (error) => error.blockers.includes(code),
    `${code} did not block a transition`
  )
  assert.equal(ran, false, `the transition body ran while ${code} blocked it`)
  assert.equal(JSON.stringify(branchIds(unitManager)), before, `${code} rejection changed the branch`)
  assert.equal(controller.branch.mode, 'normal')
  assert.equal(controller.restricted, false)
  assert.equal(controller.snapshot.blockers.switch.includes(code), true, `snapshot switch blockers lost ${code}`)
}
Object.assign(facts, baseFacts())
assert.deepEqual(controller.snapshot.blockers.switch, [])
let quietRuns = 0
await controller.transition(async () => { quietRuns += 1 })
assert.equal(quietRuns, 1)

// -- work reservations: the prompt preparation window is a fact --------------

const releaseWork = controller.beginWork('background')
assert.equal(typeof releaseWork, 'function')
assert.equal(controller.snapshot.blockers.switch.includes('busy'), true)
await assert.rejects(controller.transition(async () => 'x'), (error) => error.blockers.includes('busy'))
assert.equal(controller.transitionBusy, false, 'a rejected transition kept the lock')
releaseWork()
releaseWork() // idempotent
assert.deepEqual(controller.snapshot.blockers.switch, [])
const ranAfterRelease = await controller.transition(async () => 'ran')
assert.equal(ranAfterRelease, 'ran')

// -- the transition lock is synchronous and exclusive ------------------------

let openGate
const gate = new Promise((resolve) => { openGate = resolve })
const held = controller.transition(async () => { await gate; return 'held' })
assert.equal(controller.transitionBusy, true, 'the lock was not taken synchronously')
await assert.rejects(controller.transition(async () => 'nested'), (error) => error.blockers.includes('transition'))
assert.throws(() => controller.checkWorkAdmission(), (error) => error.blockers.includes('transition'))
assert.throws(() => controller.beginWork('user'), (error) => error.blockers.includes('transition'))
assert.equal(controller.snapshot.blockers.switch.includes('transition'), true)
openGate()
assert.equal(await held, 'held')
assert.equal(controller.transitionBusy, false)
assert.equal(controller.snapshot.blockers.switch.includes('transition'), false)
controller.checkWorkAdmission()

// -- restricted mode fails closed on an unsupported protocol version ---------

unitManager.appendCustomEntry(PLAN_MODE_ENTRY, { version: 1, mode: 'plan', planId: 'unit-plan', via: 'toggle' })
controller.restore()
assert.equal(controller.branch.mode, 'plan')
assert.equal(controller.branch.planId, 'unit-plan')
assert.equal(controller.restricted, true)
assert.equal(controller.snapshot.mode, 'plan')
assert.equal(controller.snapshot.effectiveSandboxMode, 'read-only')
assert.equal(controller.snapshot.configuredSandboxMode, 'danger-full-access')
assert.equal(controller.snapshot.planId, 'unit-plan')

const unsupportedManager = SessionManager.create(project, unitDir)
const unsupportedFile = join(unitDir, 'unsupported.jsonl')
unsupportedManager.setSessionFile(unsupportedFile)
await writeFile(unsupportedFile, `${JSON.stringify(unsupportedManager.getHeader())}\n`, { flag: 'wx' })
unsupportedManager.appendCustomEntry(PLAN_MODE_ENTRY, { version: 99, mode: 'plan', planId: 'future' })
const unsupportedFacts = baseFacts()
const unsupported = new PlanController({
  manager: unsupportedManager,
  storage: new PlanStorage(unsupportedManager),
  facts: () => unsupportedFacts,
  changed: () => {}
})
assert.equal(unsupported.branch.mode, 'normal')
assert.equal(unsupported.branch.unsupported, true)
assert.equal(unsupported.restricted, true, 'an unknown protocol version must stay restricted')
assert.equal(unsupported.snapshot.mode, 'plan')
assert.equal(unsupported.snapshot.effectiveSandboxMode, 'read-only')
assert.equal(unsupported.snapshot.blockers.switch.includes('unsupported-version'), true)
assert.equal(unsupported.snapshot.blockers.submit.includes('unsupported-version'), true)
await assert.rejects(unsupported.setMode('normal'), (error) => error.blockers.includes('unsupported-version'))
await assert.rejects(unsupported.setMode('plan'), (error) => error.blockers.includes('unsupported-version'))
assert.equal(unsupported.restricted, true)
assert.equal(unsupportedManager.getBranch().some((entry) => entry.type === 'custom' && entry.customType === PLAN_MODE_ENTRY && entry.data?.version === 1), false)

// -- the submission seal: user turns open, background work cannot pass -------

assert.equal(controller.submissionLocked, false)
assert.equal(controller.snapshot.blockers.submit.includes('already-submitted'), false)
controller.observeCommittedSubmission('tool-call-1')
assert.equal(controller.submissionLocked, true)
assert.equal(controller.snapshot.blockers.submit.includes('already-submitted'), true)
assert.throws(() => controller.beginWork('background'), (error) => error.blockers.includes('already-submitted'))
const userTicket = controller.beginWork('user')
userTicket()
// No app-owned user turn is outstanding: an outside caller cannot lift the
// seal (that would be a public bypass).
controller.releaseSubmissionForUser()
assert.equal(controller.submissionLocked, true)
const liveTicket = controller.beginWork('user')
controller.releaseSubmissionForUser()
assert.equal(controller.submissionLocked, false)
liveTicket()
assert.equal(controller.snapshot.blockers.submit.includes('already-submitted'), false)
// A committed user message is proof an admitted user turn started: it opens a
// new planning turn and lifts the seal.
const committedUser = unitManager.appendMessage({ role: 'user', content: 'revise please', timestamp: Date.now() })
controller.observeCommittedSubmission('tool-call-2')
assert.equal(controller.submissionLocked, true)
controller.observeCommittedUser(committedUser)
assert.equal(controller.submissionLocked, false)
assert.equal(controller.branch.planningTurnEntryId, committedUser, 'the committed planning turn was not recorded')
// A fabricated identity is not evidence.
controller.observeCommittedSubmission('tool-call-3')
controller.observeCommittedUser('not-an-entry')
assert.equal(controller.submissionLocked, true)
assert.throws(() => controller.beginWork('background'), (error) => error.blockers.includes('already-submitted'))
controller.observeCommittedUser('')
assert.equal(controller.submissionLocked, true)

// A submit is decided inside a tool call: its own blockers never include the
// SDK being busy, while the switch blockers still do.
Object.assign(facts, baseFacts(), { sdkIdle: false })
assert.equal(controller.snapshot.blockers.switch.includes('busy'), true)
assert.equal(controller.snapshot.blockers.submit.includes('busy'), false)
Object.assign(facts, baseFacts())

// -- sequence monotonicity, including a rebuilt controller on the same path --

controller.refresh()
const stableSeq = controller.snapshot.seq
const stablePublishes = publishes
controller.refresh()
assert.equal(publishes, stablePublishes, 'refresh republished unchanged metadata')
assert.equal(controller.snapshot.seq, stableSeq)
facts.queuedMessages = 1
controller.refresh()
assert.equal(publishes > stablePublishes, true, 'a changed fact did not publish')
assert.equal(controller.snapshot.seq > stableSeq, true)
const publishedSeq = controller.snapshot.seq
facts.queuedMessages = 0
controller.refresh()
assert.equal(controller.snapshot.seq > publishedSeq, true)
// A managed rebuild on the same path continues the manager-allocated clock
// instead of restarting at 1 (which the renderer would drop as stale).
const lastSeq = controller.snapshot.seq
let rebuiltPublishes = 0
const rebuilt = new PlanController({
  manager: unitManager,
  storage: new PlanStorage(unitManager),
  facts: () => facts,
  changed: () => { rebuiltPublishes += 1 },
  nextSeq: () => ++clock
})
rebuilt.restore()
assert.equal(rebuiltPublishes, 1)
assert.equal(rebuilt.snapshot.seq > lastSeq, true)
// Without an injected clock the controller still keys the sequence by session
// path, so two instances never reuse one number.
let defaultPublishes = 0
const withDefaultClock = new PlanController({
  manager: unitManager,
  storage: new PlanStorage(unitManager),
  facts: () => baseFacts(),
  changed: () => { defaultPublishes += 1 }
})
withDefaultClock.restore()
const afterDefault = withDefaultClock.snapshot.seq
const secondDefault = new PlanController({
  manager: unitManager,
  storage: new PlanStorage(unitManager),
  facts: () => baseFacts(),
  changed: () => {}
})
secondDefault.restore()
assert.equal(secondDefault.snapshot.seq > afterDefault, true)

console.log('PASS: PlanController admission facts, reservations and sequence')

// -- the manager facade: isolated session, explicit path ---------------------

const facade = await createPlanFixture({ respond: () => [{ type: 'text', text: 'ok' }] })
try {
  await planReady(facade)
  const path = facade.managed.path
  const configured = facade.managed.sandboxMode
  assert.equal(facade.app.getPlanState(path).mode, 'normal')
  assert.equal(facade.app.getPlanState(path).configuredSandboxMode, configured)
  assert.equal(typeof facade.app.snapshot().plan?.seq, 'number')
  assert.equal(facade.app.snapshot().plan.mode, 'normal')

  // Plan overlays read-only without touching the user's stored sandbox choice.
  facade.app.setSessionSandboxMode(path, 'danger-full-access')
  const entered = await facade.app.setSessionMode({ sessionPath: path, mode: 'plan' })
  assert.equal(entered.ok, true)
  assert.equal(entered.value.effectiveSandboxMode, 'read-only')
  assert.equal(entered.value.configuredSandboxMode, 'danger-full-access')
  assert.equal(typeof entered.value.planId, 'string')
  assert.deepEqual(entered.value.blockers.switch, [])
  const planId = entered.value.planId
  assert.equal(entered.value.latest, null)
  assert.equal(facade.app.getPlanState(path).mode, 'plan')
  assert.equal(facade.app.snapshot().sandboxMode, 'read-only')
  assert.equal(facade.app.snapshot().plan.mode, 'plan')
  assert.equal(facade.managed.sandboxMode, 'danger-full-access', 'plan mode changed the stored sandbox mode')
  // Durable: the mode entry is on the file's selected branch.
  const reopened = reconstructPlan(SessionManager.open(path).getBranch())
  assert.equal(reopened.mode, 'plan')
  assert.equal(reopened.planId, planId)

  // Plan refuses a stored-sandbox change; the app-wide default stays editable.
  assert.throws(() => facade.app.setSessionSandboxMode(path, 'read-only'))
  assert.equal(facade.managed.sandboxMode, 'danger-full-access')
  assert.equal(facade.app.setSandboxMode('read-only'), 'read-only')
  facade.app.setSandboxMode(configured)

  const exited = await facade.app.setSessionMode({ sessionPath: path, mode: 'normal' })
  assert.equal(exited.ok, true)
  assert.equal(facade.app.snapshot().sandboxMode, 'danger-full-access', 'the original permission did not come back')
  assert.equal(facade.app.getPlanState(path).mode, 'normal')
  assert.equal(reconstructPlan(SessionManager.open(path).getBranch()).mode, 'normal')
  const again = await facade.app.setSessionMode({ sessionPath: path, mode: 'plan' })
  assert.equal(again.ok, true)
  assert.notEqual(again.value.planId, planId, 're-entering plan reused the old plan identity')
  assert.equal(again.value.latest, null)
  await facade.app.setSessionMode({ sessionPath: path, mode: 'normal' })

  // The metadata event is sequence-free and carries its own monotonic seq.
  const planEvents = facade.events.filter((event) => event.type === 'plan_state_update')
  assert.equal(planEvents.length >= 4, true, 'the mode changes published no metadata event')
  assert.equal(planEvents.every((event) => event.eventSequence === undefined), true)
  assert.equal(planEvents.every((event) => event.sessionPath === path), true)
  assert.equal(planEvents.some((event) => event.plan.mode === 'plan' && event.plan.effectiveSandboxMode === 'read-only'), true)
  assert.equal(planEvents.some((event) => event.plan.mode === 'normal' && event.plan.effectiveSandboxMode === 'danger-full-access'), true)
  const seqs = planEvents.map((event) => event.plan.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'metadata seq went backwards')

  // A question or notification isn't needed for this: the SDK run itself is.
  const first = facade.requests.length
  await facade.session.prompt('first')
  await settled(facade, first + 1)
  const userMessage = facade.store.getState().messages.find((message) => message.role === 'user')
  const planTurn = await facade.app.setSessionMode({ sessionPath: path, mode: 'plan' })
  assert.equal(planTurn.value.mode, 'plan')
  assert.equal(facade.app.snapshot().sandboxMode, 'read-only')
  // The resend abandons the branch the plan entry lived on; the mode must be
  // re-folded from the branch the session is actually on.
  await facade.app.resendMessage({ timestamp: userMessage.timestamp, text: 'first', images: [] })
  assert.equal(facade.app.getPlanState(path).mode, 'normal', 'the mode survived a branch move that removed it')
  assert.equal(facade.app.snapshot().sandboxMode, 'danger-full-access')
  await settled(facade, first + 2)

  // A prompt's preparation window reserves the session, so no switch slips in
  // while the SDK still reports idle.
  const notes = join(facade.project, 'notes.md')
  await writeFile(notes, '# Notes\nRead the branch protocol.\n')
  const beforePrompt = facade.requests.length
  facade.app.prompt({ text: 'please read the notes', images: [], files: [notes] })
  const raced = await facade.app.setSessionMode({ sessionPath: path, mode: 'plan' })
  assert.equal(raced.ok, false, 'a mode switch landed inside a prompt preparation window')
  assert.equal(raced.code, 'busy')
  assert.equal(raced.blockers.includes('busy'), true)
  assert.equal(facade.app.getPlanState(path).mode, 'normal')
  await settled(facade, beforePrompt + 1)
  const afterPreparation = await facade.app.setSessionMode({ sessionPath: path, mode: 'plan' })
  assert.equal(afterPreparation.ok, true)
  assert.equal(afterPreparation.value.effectiveSandboxMode, 'read-only')
  await facade.app.setSessionMode({ sessionPath: path, mode: 'normal' })

  // Unknown protocol version: shown as incompatible and locked fail-closed.
  const manager = facade.managed.session.sessionManager
  const modeEntries = () => readFileSync(path, 'utf8').split('\n').filter((line) => line.includes('"pith_plan_mode"')).length
  manager.appendCustomEntry(PLAN_MODE_ENTRY, { version: 99, mode: 'plan', planId: 'future' })
  const entriesBefore = modeEntries()
  await facade.app.reloadSession(path)
  const locked = facade.app.getPlanState(path)
  assert.equal(locked.mode, 'plan', 'an unknown protocol version must stay restricted')
  assert.equal(locked.effectiveSandboxMode, 'read-only')
  assert.equal(facade.app.snapshot().sandboxMode, 'read-only')
  assert.equal(locked.blockers.switch.includes('unsupported-version'), true)
  const refused = await facade.app.setSessionMode({ sessionPath: path, mode: 'normal' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'unsupported-version')
  assert.equal(refused.blockers.includes('unsupported-version'), true)
  assert.equal(modeEntries(), entriesBefore, 'a refused transition wrote a mode entry')
  assert.equal(reconstructPlan(manager.getBranch()).unsupported, true)
  // The facade addresses sessions by the request's own path, never the active one.
  assert.throws(() => facade.app.getPlanState('missing-session.jsonl'), /No such session/)
  const unknownPath = await facade.app.setSessionMode({ sessionPath: 'missing-session.jsonl', mode: 'plan' })
  assert.equal(unknownPath.ok, false)
  assert.equal(unknownPath.code, 'no-session')
  const unknownMode = await facade.app.setSessionMode({ sessionPath: path, mode: 'yolo' })
  assert.equal(unknownMode.ok, false)
  assert.equal(unknownMode.code, 'invalid-mode')
} finally {
  await facade.close()
}

console.log('PASS: manager facade mode switch, permission separation and branch restore')

// -- notification-derived facts and a genuine storage failure ----------------

const notified = await createPlanFixture({ respond: () => [{ type: 'text', text: 'ok' }] })
try {
  await planReady(notified)
  const path = notified.managed.path
  assert.equal(notified.app.getPlanState(path).mode, 'normal')

  // A finished background command is a pending delivery, not model text.
  notified.managed.notifications.complete({
    id: 'plan-task-1',
    sessionId: notified.session.sessionId,
    sessionPath: path,
    toolCallId: 'tool-call-unreleased',
    command: 'echo hi',
    cwd: notified.project,
    status: 'completed',
    background: true,
    startedAt: Date.now(),
    outputChars: 0,
    logPath: join(notified.temporary, 'task.log'),
    logTruncated: false,
    revision: 1
  })
  await until(
    () => notified.app.getPlanState(path).blockers.switch.includes('deliveries'),
    'a pending completion did not reach the plan metadata'
  )
  const pendingSwitch = await notified.app.setSessionMode({ sessionPath: path, mode: 'plan' })
  assert.equal(pendingSwitch.ok, false)
  assert.equal(pendingSwitch.blockers.includes('deliveries'), true)

  // An async question's timeout is a delivery too (no wake, no model text).
  notified.managed.askUser.settle({
    toolCallId: 'ask-call-unreleased',
    details: { kind: 'pi-app-ask-user', status: 'cancelled', reason: 'timeout', questions: [], answers: null },
    text: 'no answer was given'
  })
  await until(
    () => notified.app.getPlanState(path).blockers.switch.includes('deliveries'),
    'a timed-out question did not reach the plan metadata'
  )

  // Clearing a pending set refreshes the metadata without any model event.
  notified.managed.notifications.pause()
  notified.managed.askUser.dispose()
  await until(
    () => !notified.app.getPlanState(path).blockers.switch.includes('deliveries'),
    'cleared notifications still blocked a switch'
  )
  const metadataEvents = notified.events.filter((event) => event.type === 'plan_state_update')
  assert.equal(metadataEvents.some((event) => event.plan.blockers.switch.includes('deliveries')), true)
  assert.equal(metadataEvents.at(-1).plan.blockers.switch.includes('deliveries'), false)

  // A REAL append failure: the session file is unwritable, so the SDK records
  // the entry in memory and the write throws.
  const before = notified.requests.length
  await notified.session.prompt('make it durable')
  await settled(notified, before + 1)
  const storedFile = notified.managed.path
  chmodSync(storedFile, 0o444)
  try {
    const failed = await notified.app.setSessionMode({ sessionPath: path, mode: 'plan' })
    assert.equal(failed.ok, false, 'a mode switch persisted while the write failed')
    assert.equal(failed.code, 'storage')
    assert.equal(failed.blockers.includes('storage'), true)
    assert.equal(notified.app.getPlanState(path).mode, 'normal', 'a failed write published plan mode')
    assert.equal(notified.app.getPlanState(path).effectiveSandboxMode, notified.managed.sandboxMode)
    assert.equal(notified.app.snapshot().sandboxMode, notified.managed.sandboxMode)
    assert.equal(
      notified.events.filter((event) => event.type === 'plan_state_update').some((event) => event.plan.mode === 'plan'),
      false,
      'a failed transition published actionable plan state'
    )
    assert.equal(readFileSync(storedFile, 'utf8').includes('"pith_plan_mode"'), false)
    assert.equal(reconstructPlan(notified.managed.session.sessionManager.getBranch()).mode, 'normal')
    // The storage failure latches: no later switch can go through either.
    const retry = await notified.app.setSessionMode({ sessionPath: path, mode: 'plan' })
    assert.equal(retry.ok, false)
    assert.equal(retry.code, 'storage')
    assert.equal(retry.blockers.includes('storage'), true)
  } finally {
    chmodSync(storedFile, 0o644)
  }
} finally {
  await notified.close()
}

console.log('PASS: notification-driven metadata and the durable storage failure latch')

await rm(temporary, { recursive: true, force: true })
console.log('PASS: all plan-mode checks')
