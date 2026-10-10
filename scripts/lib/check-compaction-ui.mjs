import assert from 'node:assert/strict'

/** Real ChatView/PiStore/beUI: region separation, live-to-persisted identity,
 * bounded summary scrolling, cancellation, failure, locales and old sessions. */
export async function checkCompactionUi(evaluate, pause, click, capture = async () => {}) {
  const row = '#turn-fixture [data-summary-row="compaction"]'
  const read = () => evaluate(`(() => {
    const row = document.querySelector('${row}');
    const process = row?.querySelector('[data-compaction-process]');
    const summary = row?.querySelector('[data-compaction-summary]');
    const viewport = summary?.closest('[role="log"]');
    return { status:row?.getAttribute('data-state'), open:row?.querySelector('[data-agent-trigger]').getAttribute('aria-expanded'),
      process:process?.textContent ?? '', summary:summary?.textContent ?? '', count:document.querySelectorAll('${row}').length,
      separate:!!process&&!!summary&&!viewport.contains(process),
      steps:[...row?.querySelectorAll('[data-compaction-step]') ?? []].map(step=>step.getAttribute('data-state')),
      requests:[...row?.querySelectorAll('[data-compaction-request]') ?? []].map(request=>request.getAttribute('data-state')),
      scrollable:!!viewport&&viewport.scrollHeight>viewport.clientHeight, processTop:process?.getBoundingClientRect().top };
  })()`)
  await evaluate(`window.startTurnFixture();
    window.visualRevision=10;
    window.visualProcess={id:'visual-compaction',reason:'manual',status:'running',phase:'summarizing',startedAt:Date.now()-6000,
      tokensBefore:120000,requestCount:2,range:{summarizedMessages:48,keptMessages:12,previousSummary:true,splitTurn:true},
      requests:[{id:'history-request',status:'success',startedAt:Date.now()-6000,endedAt:Date.now()-3000,model:'fixture-model',inputTokens:8000,outputTokens:1000},
        {id:'prefix-request',status:'running',startedAt:Date.now()-3000,model:'fixture-model'}]};
    window.visualUpdate=()=>window.turnStore.dispatch({type:'compaction_process_update',sessionPath:'/ui/session',compactionProcess:{revision:++window.visualRevision,process:window.visualProcess}});
    window.visualUpdate();window.turnStep({type:'compaction_start',reason:'manual'});`)
  await pause(150)
  assert.equal((await read()).process, '', 'collapsed rows do not mount process details')
  await click(row + ' [data-agent-trigger]')
  await pause(200)
  let state = await read()
  assert.equal(state.separate, true, 'process header and final summary occupy separate regions')
  assert.match(state.process, /48 messages.*12 recent messages/)
  assert.deepEqual(state.steps, ['success', 'running', 'pending'])
  assert.deepEqual(state.requests, ['success', 'running'])
  assert.match(state.summary, /final summary will appear/)
  await capture('compaction-process-running')

  await evaluate(`window.visualProcess={...window.visualProcess,status:'success',phase:'applying',endedAt:Date.now(),tokensAfter:24000,
    usage:{inputTokens:9000,outputTokens:1500,cost:0},
    requests:window.visualProcess.requests.map(request=>({...request,status:'success',endedAt:Date.now()}))};
    window.visualSummary='## Final checkpoint\\n\\n'+Array.from({length:80},(_,index)=>'Preserved decision '+index+'.').join('\\n\\n');
    window.visualUpdate();window.turnStep({type:'compaction_end',messages:[
      {role:'user',content:'original request',timestamp:10},
      {role:'compactionSummary',timestamp:900,summary:window.visualSummary,tokensBefore:120000,process:window.visualProcess}
    ]});window.turnStep({type:'agent_settled'});`)
  await pause(250)
  state = await read()
  assert.equal(state.count, 1, 'settlement replaces the live row with one persisted row')
  assert.equal(state.open, 'true', 'a disclosure opened during execution stays open on completion')
  assert.equal(state.separate, true)
  assert.deepEqual(state.steps, ['success', 'success', 'success'])
  assert.match(state.process, /120\.0k tokens.*24\.0k tokens/)
  assert.match(state.process, /9\.0k input.*1\.5k output tokens/)
  assert.match(state.summary, /Final checkpoint/)
  assert.equal(state.scrollable, true, 'only the final summary uses the capped result viewport')
  await evaluate(`const body=document.querySelector('${row} [data-compaction-summary]').closest('[role="log"]');body.scrollTop=body.scrollHeight;`)
  await pause(80)
  assert.equal((await read()).processTop, state.processTop, 'scrolling the summary leaves the process header visible')
  await evaluate(`document.querySelector('${row} [data-compaction-summary]').closest('[role="log"]').scrollTop=0`)
  await capture('compaction-process-completed')

  await evaluate(`window.visualProcess={...window.visualProcess,id:'failed-visual-compaction',status:'error',phase:'summarizing',tokensAfter:undefined,errorMessage:'Summary provider unavailable'};
    window.turnStore.applySnapshot({...window.turnSnapshot([{role:'user',timestamp:10,content:'original request'}],false),
      compactionProcess:{revision:++window.visualRevision,process:window.visualProcess}});`)
  await pause(150)
  state = await read()
  assert.equal(state.open, 'true', 'a failed snapshot opens its process detail')
  assert.match(state.process, /Summary provider unavailable/)
  assert.doesNotMatch(state.summary, /Summary provider unavailable/, 'provider errors belong to the process region')
  assert.match(state.summary, /No final summary/)
  assert.deepEqual(state.steps, ['success', 'error', 'pending'])

  await evaluate(`window.visualProcess={...window.visualProcess,id:'cancelled-visual-compaction',status:'cancelled',errorMessage:undefined};
    window.turnStore.applySnapshot({...window.turnSnapshot([{role:'user',timestamp:10,content:'original request'}],false),
      compactionProcess:{revision:++window.visualRevision,process:window.visualProcess}});`)
  await pause(150)
  await click(row + ' [data-agent-trigger]')
  state = await read()
  assert.equal(state.status, 'cancelled')
  assert.deepEqual(state.steps, ['success', 'cancelled', 'pending'])
  assert.match(state.summary, /No summary was applied/)

  for (const [locale, labels] of [['zh-CN',['总结过程','最终总结','估算']],['zh-TW',['總結過程','最終總結','估算']]]) {
    await evaluate(`window.startTurnFixture('${locale}');window.turnStore.applySnapshot({...window.turnSnapshot([
      {role:'compactionSummary',timestamp:900,summary:'## Recorded summary',tokensBefore:120000,
        process:{...window.visualProcess,id:'localized-${locale}',status:'success',phase:'applying',tokensAfter:24000}}
    ],false)});`)
    await pause(100)
    await click(row + ' [data-agent-trigger]')
    await pause(250)
    state = await read()
    assert(state.process.includes(labels[0]) && state.process.includes(labels[2]))
    assert(state.summary.includes(labels[1]))
    await capture('compaction-process-' + locale)
  }

  await evaluate(`window.startTurnFixture();window.turnStore.applySnapshot(window.turnSnapshot([
    {role:'compactionSummary',timestamp:900,summary:'Historical checkpoint.',tokensBefore:120000}
  ],false));`)
  await pause(100)
  await click(row + ' [data-agent-trigger]')
  state = await read()
  assert.match(state.process, /Process details were not recorded/)
  assert.match(state.summary, /Historical checkpoint/)
  assert.equal(state.requests.length, 0, 'old summaries do not invent historical requests')
  console.log('PASS: separate process/final-summary regions retain open state, scrolling, failure/cancellation outcomes and all locales.')
}
