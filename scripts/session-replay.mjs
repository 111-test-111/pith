#!/usr/bin/env node
/** Explicit fixture recording or strict offline replay; never calls a real API. */
import { resolve } from 'node:path'
import { createReplayFixture } from './lib/session-replay-fixture.mjs'
import { assertReplayEqual, createSessionRecorder, createSessionReplay, loadSessionReplay, saveSessionReplay, SESSION_REPLAY_FORMAT } from './lib/session-replay.mjs'
import { recordingScenario, scenarioContract, syntheticProvider } from './lib/session-replay-scenarios.mjs'
import { installReplayOfflineGuard } from './lib/session-replay-offline.mjs'

installReplayOfflineGuard()

const [mode, ...arguments_] = process.argv.slice(2)
const args = new Map()
for (let index = 0; index < arguments_.length; index++) {
  const key = arguments_[index]
  if (key === '--overwrite') args.set(key, true)
  else if (['--scenario', '--output', '--fixture'].includes(key) && arguments_[index + 1]) args.set(key, arguments_[++index])
  else throw new Error(`Unknown or incomplete argument: ${key}`)
}
if (mode === 'record' && args.get('--scenario') && args.get('--output') && !args.has('--fixture')) {
  const source = recordingScenario(args.get('--scenario'))
  const scenario = scenarioContract(source)
  const fixture = await createReplayFixture({ scenario, streamFactory: normalizer => createSessionRecorder({ normalizer, stream: syntheticProvider(source) }) })
  try {
    await fixture.run()
    fixture.driver.assertComplete()
    const expected = await fixture.outcome()
    await saveSessionReplay(resolve(args.get('--output')), { format: SESSION_REPLAY_FORMAT, source: 'offline-synthetic-provider/real-sdk-session', scenario, calls: fixture.driver.calls, expected }, { overwrite: args.has('--overwrite') })
    console.log(`Recorded ${scenario.id}: ${fixture.driver.calls.length} provider calls (offline)`)
  } finally { await fixture.close() }
} else if (mode === 'replay' && args.get('--fixture') && args.size === 1) {
  const recorded = await loadSessionReplay(resolve(args.get('--fixture')))
  const fixture = await createReplayFixture({ scenario: recorded.scenario, streamFactory: normalizer => createSessionReplay({ normalizer, calls: recorded.calls }) })
  try {
    await fixture.run()
    fixture.driver.assertConsumed()
    assertReplayEqual(await fixture.outcome(), recorded.expected, `${recorded.scenario.id} outcome`)
    console.log(`Replayed ${recorded.scenario.id}: ${recorded.calls.length} provider calls, transcript/tools/delivery/trajectory match`)
  } finally { await fixture.close() }
} else {
  throw new Error('Usage: node scripts/session-replay.mjs record --scenario <id> --output <path> [--overwrite] | replay --fixture <path> (all modes offline)')
}
