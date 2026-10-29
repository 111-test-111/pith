import assert from 'node:assert/strict'

/** Uses the real ChatView/beUI fixture from check-bash-task-ui. */
export async function checkContinueUi(evaluate, pause) {
  await evaluate('window.continuePlanSeq=1000')
  const count = () => evaluate(`document.querySelectorAll('#turn-fixture button[aria-label="Continue response"]').length`)
  const snapshot = async (reason, extra = '', suffix = '') => {
    await evaluate(`window.expectedCards=1;window.turnStore.applySnapshot({...window.turnSnapshot([
      ...window.initialTurnMessages,
      {...window.round(30,window.prose('unfinished answer')),stopReason:${JSON.stringify(reason)}}${suffix}
    ],false),plan:{seq:++window.continuePlanSeq,mode:'normal',approval:null,latest:null,blockers:{submit:[],switch:[],approve:[]}}${extra}})`)
    await pause(80)
  }
  for (const reason of ['aborted', 'error', 'length', 'toolUse']) {
    await snapshot(reason)
    assert.equal(await count(), 1, reason + ' exposes Continue only at the frontier')
  }
  await snapshot('stop')
  assert.equal(await count(), 0, 'a completed answer never offers Continue')
  await snapshot('aborted', ',isStreaming:true')
  assert.equal(await count(), 0, 'no Continue during automatic retries or a live run')
  await snapshot('aborted', ',subagentChild:true')
  assert.equal(await count(), 0, 'an opened child remains read-only')
  await snapshot('aborted', ',initializing:true')
  assert.equal(await count(), 0, 'preparing tools cannot continue yet')
  await snapshot('toolUse', `,plan:{seq:++window.continuePlanSeq,mode:'plan',approval:null,latest:null,blockers:{submit:['already-submitted'],switch:[],approve:[]}}`)
  assert.equal(await count(), 0, 'a sealed plan must use its approval card')
  await snapshot('aborted', '', `,{role:'user',timestamp:40,content:'A newer request'}`)
  assert.equal(await count(), 0, 'an older interrupted turn cannot resume into a newer request')
  await snapshot('aborted')
  assert.equal(await count(), 1, 'Continue returns for the unfinished frontier')
  await evaluate(`window.interruptedGroup=document.querySelector('#turn-fixture [data-assistant-group]');document.querySelector('#turn-fixture button[aria-label="Continue response"]').click()`)
  assert.equal(await evaluate('window.menuContinues.at(-1).timestamp'), 30)
  await evaluate(`window.turnStep({type:'agent_start',changeScopeId:'scope-a'});
    window.turnStep({type:'message_end',message:{role:'custom',customType:'pith_turn_continuation',display:false,content:'HIDDEN_CONTINUE_INSTRUCTION',timestamp:40}});
    window.turnStep({type:'message_start',message:window.round(50,window.prose('continued answer'))})`)
  await pause(80)
  assert.equal(await count(), 0)
  assert.equal(await evaluate(`document.querySelector('#turn-fixture [data-assistant-group]')===window.interruptedGroup`), true, 'the original assistant group stays mounted')
  assert.equal(await evaluate(`document.querySelectorAll('#turn-fixture [data-assistant-group]').length`), 1)
  assert.equal(await evaluate(`document.querySelectorAll('#turn-fixture [data-rail-id]').length`), 1, 'no synthetic user bubble or rail tick')
  assert.equal(await evaluate(`document.querySelector('#turn-fixture').textContent.includes('HIDDEN_CONTINUE_INSTRUCTION')`), false)
  await evaluate(`window.turnStep({type:'message_end',message:window.round(50,window.prose('continued answer'))});window.turnStep({type:'agent_settled'},1)`)
  await pause(80)
  assert.equal(await count(), 0)
  assert.equal(await evaluate(`document.querySelector('#turn-fixture [data-assistant-group]')===window.interruptedGroup`), true)
  assert.equal(await evaluate(`document.querySelectorAll('#turn-fixture ul[data-plain-list]').length`), 1, 'the existing changed-files list returns in the same turn')
  console.log('PASS: Continue visibility, click identity, sealed plans/read-only sessions and same-node live continuation without a user bubble or extra rail tick.')
}
