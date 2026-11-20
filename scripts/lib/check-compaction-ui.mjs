import assert from 'node:assert/strict'

/** Real ChatView/PiStore/beUI: region separation, live-to-persisted identity,
 * ordinary process rows, fixed round slots, scrolling and old sessions. */
export async function checkCompactionUi(evaluate, pause, click, capture = async () => {}) {
  const row = '#turn-fixture [data-summary-row="compaction"]'
  const read = () => evaluate(`(() => {
    const row = document.querySelector('${row}');
    const meta = row?.querySelector('[data-tool-result-meta]');
    const process = row?.querySelector('[data-compaction-process]');
    const bar = process?.querySelector('[data-compaction-context-bar]');
    const fill = bar?.querySelector('[data-compaction-context-fill]');
    const barBounds = bar?.getBoundingClientRect();
    const fillBounds = fill?.getBoundingClientRect();
    const summary = row?.querySelector('[data-compaction-summary]');
    const viewport = summary?.closest('[role="log"]');
    return { status:row?.getAttribute('data-state'), open:row?.querySelector('[data-agent-trigger]').getAttribute('aria-expanded'),
      meta:meta?.textContent ?? '', comparison:!!meta?.querySelector('[data-app-icon="ArrowRight"]'),
      process:process?.textContent ?? '', summary:summary?.textContent ?? '', count:document.querySelectorAll('${row}').length,
      separate:!!process&&!!summary&&!viewport.contains(process),
      steps:[...row?.querySelectorAll('[data-compaction-step]') ?? []].map(step=>step.getAttribute('data-state')),
      requestRegion:!!process?.querySelector('[data-compaction-requests], [data-compaction-request], [data-compaction-usage]'),
      bar:bar ? { filled:!!fill, ratio:fillBounds ? fillBounds.width/barBounds.width : null,
        overlaid:!!fillBounds&&Math.abs(fillBounds.top-barBounds.top)<0.1&&Math.abs(fillBounds.height-barBounds.height)<0.1 } : null,
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
  let state = await read()
  assert.equal(state.process, '', 'collapsed rows do not mount process details')
  assert.equal(state.meta, 'Before 120.0k tokens', 'live metadata uses the recorded pre-summary context')
  assert.equal(state.comparison, false, 'running summaries do not invent a post-summary estimate')
  await click(row + ' [data-agent-trigger]')
  await pause(200)
  state = await read()
  assert.equal(state.separate, true, 'process header and final summary occupy separate regions')
  assert.match(state.process, /48 messages.*12 recent messages/)
  assert.deepEqual(state.steps, ['success', 'running', 'pending'])
  assert.equal(state.requestRegion, false, 'request statistics are absent even while summarization is running')
  assert.equal(state.bar.filled, false, 'the original-context track has no invented remaining estimate')
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
  assert.match(state.meta, /Before 120\.0k tokens.*After 24\.0k tokens/, 'the header compares context sizes rather than request billing')
  assert.equal(state.comparison, true)
  assert.match(state.process, /120\.0k tokens.*24\.0k tokens/)
  assert.equal(state.requestRegion, false)
  assert.doesNotMatch(state.process, /fixture-model|input.*output tokens/, 'model requests and billing do not render in process details')
  assert.equal(state.bar.overlaid, true, 'remaining context fills the original track instead of using a second row')
  assert(Math.abs(state.bar.ratio - 0.2) < 0.001, '24k remaining context occupies 20% of the original 120k track')
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
  assert.equal(state.meta, 'Before 120.0k tokens')
  assert.equal(state.comparison, false)
  assert.match(state.process, /Summary provider unavailable/)
  assert.doesNotMatch(state.summary, /Summary provider unavailable/, 'provider errors belong to the process region')
  assert.match(state.summary, /No final summary/)
  assert.deepEqual(state.steps, ['success', 'error', 'pending'])
  assert.equal(state.bar.filled, false)

  await evaluate(`window.visualProcess={...window.visualProcess,id:'cancelled-visual-compaction',status:'cancelled',errorMessage:undefined};
    window.turnStore.applySnapshot({...window.turnSnapshot([{role:'user',timestamp:10,content:'original request'}],false),
      compactionProcess:{revision:++window.visualRevision,process:window.visualProcess}});`)
  await pause(150)
  await click(row + ' [data-agent-trigger]')
  state = await read()
  assert.equal(state.status, 'cancelled')
  assert.equal(state.meta, 'Before 120.0k tokens')
  assert.equal(state.comparison, false)
  assert.deepEqual(state.steps, ['success', 'cancelled', 'pending'])
  assert.equal(state.bar.filled, false)
  assert.match(state.summary, /No summary was applied/)

  for (const [locale, labels] of [['zh-CN',['总结过程','最终总结','估算','总结前','总结后']],['zh-TW',['總結過程','最終總結','估算','總結前','總結後']]]) {
    await evaluate(`window.startTurnFixture('${locale}');window.turnStore.applySnapshot({...window.turnSnapshot([
      {role:'compactionSummary',timestamp:900,summary:'## Recorded summary',tokensBefore:120000,
        process:{...window.visualProcess,id:'localized-${locale}',status:'success',phase:'applying',tokensAfter:24000}}
    ],false)});`)
    await pause(100)
    state = await read()
    assert.equal(state.open, 'false')
    assert(state.meta.includes(labels[3] + ' 120.0k tokens') && state.meta.includes(labels[4] + ' 24.0k tokens'), 'both context sizes are visible in the collapsed localized header')
    assert.equal(state.comparison, true)
    await capture('compaction-header-' + locale)
    await click(row + ' [data-agent-trigger]')
    await pause(250)
    state = await read()
    assert(state.process.includes(labels[0]) && state.process.includes(labels[2]))
    assert(state.summary.includes(labels[1]))
    assert.equal(state.requestRegion, false)
    assert.equal(state.bar.overlaid, true)
    assert(Math.abs(state.bar.ratio - 0.2) < 0.001)
    await capture('compaction-process-' + locale)
  }

  await evaluate(`window.startTurnFixture();window.turnStore.applySnapshot(window.turnSnapshot([
    {role:'compactionSummary',timestamp:900,summary:'Historical checkpoint.',tokensBefore:120000}
  ],false));`)
  await pause(100)
  await click(row + ' [data-agent-trigger]')
  state = await read()
  assert.equal(state.meta, 'Before 120.0k tokens')
  assert.equal(state.comparison, false, 'legacy summaries retain before-only metadata when no estimate was recorded')
  assert.match(state.process, /Process details were not recorded/)
  assert.match(state.summary, /Historical checkpoint/)
  assert.equal(state.requestRegion, false)
  assert.equal(state.bar, null, 'old summaries without process statistics do not invent a ratio')
  console.log('PASS: before/after context metadata and one proportional context bar omit request statistics and retain open state, scrolling, failure/cancellation outcomes and all locales.')

  // A successful manual compaction inside a running turn stays after the
  // output that preceded it, even when that same scope continues with more
  // assistant rounds or a steer whose creation time predates the summary.
  const readAnchor = () => evaluate(`(() => {
    const root = document.querySelector('#turn-fixture');
    const summary = root.querySelector('[data-summary-row="compaction"]');
    const prose = [...root.querySelectorAll('[data-row="text"]')];
    const before = prose.find(node=>node.textContent.includes('Output before summary.'));
    const after = prose.find(node=>/continuation after summary/.test(node.textContent));
    const steer = [...root.querySelectorAll('[data-rail-id]')].find(node=>node.textContent.includes('Steered after summary'));
    const follows = (first,second) => !!first&&!!second&&!!(first.compareDocumentPosition(second)&Node.DOCUMENT_POSITION_FOLLOWING);
    return { count:root.querySelectorAll('[data-summary-row="compaction"]').length,
      afterOriginal:follows(before,summary), beforeContinuation:follows(summary,after), beforeSteer:follows(summary,steer),
      host:summary?.closest('[data-assistant-group]')?.getAttribute('data-assistant-group'),
      groups:root.querySelectorAll('[data-assistant-group]').length, folds:root.querySelectorAll('[data-turn-process]').length,
      inProcess:!!summary?.closest('[data-turn-process]'), spinners:root.querySelectorAll('[data-spinner-loader]').length };
  })()`)
  await evaluate(`window.startTurnFixture();
    window.anchoredHistory=[{role:'user',timestamp:10,content:'original request'},
      window.round(20,[...window.prose('Output before summary.'),{type:'toolCall',id:'before-summary',name:'read',arguments:{path:'before-summary.ts'}}]),
      {role:'toolResult',toolCallId:'before-summary',toolName:'read',timestamp:21,isError:false,content:[{type:'text',text:'Read completed.'}]}];
    window.turnStore.applySnapshot(window.turnSnapshot(window.anchoredHistory));
    window.visualRevision=100;
    window.visualProcess={id:'anchored-compaction',reason:'manual',status:'running',phase:'summarizing',startedAt:Date.now(),requests:[],requestCount:0};
    window.visualUpdate();window.turnStep({type:'compaction_start',reason:'manual'});`)
  await pause(100)
  assert.equal((await readAnchor()).count, 1)
  assert.equal((await readAnchor()).spinners, 1)
  await evaluate(`window.visualProcess={...window.visualProcess,status:'success',phase:'applying',endedAt:Date.now()};
    window.anchoredCheckpoint={role:'compactionSummary',timestamp:25,sessionEntryId:'anchored-checkpoint',
      summary:'Keep the preceding output.',tokensBefore:1000,process:window.visualProcess};
    window.visualUpdate();window.turnStep({type:'compaction_end',messages:[...window.anchoredHistory,window.anchoredCheckpoint]});`)
  await pause(100)
  let anchor = await readAnchor()
  assert.equal(anchor.afterOriginal, true, 'completion keeps the summary after the output it summarized')
  assert.equal(anchor.host, '20', 'the completed summary remains an ordinary process row inside the original turn')
  assert.equal(anchor.groups, 1)
  assert.equal(anchor.folds, 0, 'compaction completion must not produce a whole-turn fold header')
  assert.equal(anchor.spinners, 1)
  await evaluate(`window.turnStep({type:'message_start',message:window.round(30,window.prose('Live continuation after summary.'))});`)
  await pause(100)
  anchor = await readAnchor()
  assert.equal(anchor.afterOriginal, true, 'streaming continuation cannot move the summary before original output')
  assert.equal(anchor.beforeContinuation, true)
  assert.equal(anchor.count, 1)
  assert.equal(anchor.spinners, 1)
  assert.equal(anchor.host, '20')
  assert.equal(anchor.groups, 1, 'the continuation extends the same assistant turn')
  assert.equal(anchor.folds, 0)
  await evaluate(`window.turnStep({type:'message_end',message:window.round(30,window.prose('Finished continuation after summary.'))});
    window.turnStep({type:'agent_end'});`)
  await pause(100)
  assert.equal((await readAnchor()).folds, 0, 'agent_end alone does not settle or fold the ongoing run')
  await evaluate(`window.turnStep({type:'agent_settled'});`)
  await pause(150)
  anchor = await readAnchor()
  assert.equal(anchor.afterOriginal, true, 'settling and folding the process cannot move the summary')
  assert.equal(anchor.beforeContinuation, true)
  assert.equal(anchor.count, 1)
  assert.equal(anchor.spinners, 0)
  assert.equal(anchor.groups, 1)
  assert.equal(anchor.folds, 1, 'only actual run settlement folds the whole turn once')
  assert.equal(anchor.inProcess, true, 'the summary folds with the ordinary tool process')
  await evaluate(`document.querySelector('#turn-fixture [data-turn-process]').parentElement.previousElementSibling.querySelector('button').click();`)
  await pause(200)
  await capture('compaction-fixed-slot')
  await evaluate(`window.savedCompactionMessages=window.turnStore.getState().messages;
    window.startTurnFixture();
    window.turnStore.applySnapshot(window.turnSnapshot(window.savedCompactionMessages,false));`)
  await pause(150)
  anchor = await readAnchor()
  assert.equal(anchor.afterOriginal, true, 'reopening retains the same persisted summary boundary')
  assert.equal(anchor.beforeContinuation, true)
  assert.equal(anchor.count, 1)
  assert.equal(anchor.groups, 1)
  assert.equal(anchor.inProcess, true)

  await evaluate(`window.startTurnFixture();
    window.turnStore.applySnapshot(window.turnSnapshot([...window.anchoredHistory,window.anchoredCheckpoint]));
    window.turnStep({type:'message_end',message:{role:'user',timestamp:24,content:'Steered after summary'}});
    window.turnStep({type:'message_end',message:window.round(40,window.prose('Finished the steer.'))});
    window.turnStep({type:'agent_settled'});`)
  await pause(150)
  anchor = await readAnchor()
  assert.equal(anchor.host, '20', 'steering never moves the summary into another turn')
  assert.equal(anchor.afterOriginal, true)
  assert.equal(anchor.beforeSteer, true, 'queued steering follows the persisted summary despite an earlier creation timestamp')
  assert.equal(anchor.count, 1)
  console.log('PASS: compaction stays an ordinary row in the same live turn, anchors between rounds and folds only with real settlement.')
}
