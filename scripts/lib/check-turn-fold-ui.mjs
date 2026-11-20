import assert from 'node:assert/strict'

/** Exercise the real ChatView/PiStore and beUI disclosures, including snapshots
 * and the live → settled transition. No model calls or persisted user data. */
export async function checkTurnFoldUi(evaluate, pause, capture = async () => {}) {
  await evaluate(`window.startTurnFixture();
    window.foldRead = () => {
      const group = document.querySelector('#turn-fixture [data-assistant-group]');
      const column = group.querySelector('[data-slot="message-content"]');
      const bodies = [...group.querySelectorAll('[data-turn-process]')];
      const body = bodies[0];
      return {
        groups: document.querySelectorAll('#turn-fixture [data-assistant-group]').length,
        folded: body?.textContent ?? '',
        tail: [...column.children].filter(row => !bodies.some(body => row.contains(body))).map(row => row.textContent).join(' '),
        hidden: body?.parentElement.getAttribute('aria-hidden'),
        height: body?.parentElement.getBoundingClientRect().height,
        inert: body?.parentElement.inert,
        errors: body ? [...body.querySelectorAll('button[aria-expanded]')].map(button => button.textContent).filter(text => /^(Error|Stopped)/.test(text)) : [],
        actions: [...column.querySelectorAll('button[aria-label]')].filter(button => !button.closest('[data-turn-process]')).map(button => button.getAttribute('aria-label')),
      };
    };
    window.toggleTurnFold = () => document.querySelector('#turn-fixture [data-turn-process]').parentElement.previousElementSibling.querySelector('button').click();`)
  const snapshot = async (rounds, live = false, withWrite = true) => {
    await evaluate(`window.expectedCards=${live || !withWrite ? 0 : 1};
      window.turnStore.applySnapshot(window.turnSnapshot([
        ...window.initialTurnMessages.slice(0,${withWrite ? 3 : 1}),${rounds}
      ],${live}));`)
    await pause(80)
  }
  const read = () => evaluate('window.foldRead()')
  const toggle = async () => { await evaluate('window.toggleTurnFold()'); await pause(260) }
  const assertClosed = (state, label, stopped = false) => {
    assert.equal(state.hidden, 'true', label + ': process is collapsed')
    assert.equal(state.height, 0, label + ': collapsed process takes no height')
    assert.equal(state.inert, true, label + ': collapsed controls cannot receive focus')
    assert.doesNotMatch(state.tail, /Error|phase|partial/, label + ': no process/error leaks below the fold')
    if (stopped) assert.match(state.tail, /Stopped/, label + ': terminal Stop remains visible')
    else assert.doesNotMatch(state.tail, /Stopped/, label + ': earlier Stops belong to the process')
  }

  // Multiple failed attempts and a manual continuation still share one final
  // answer. The final round itself contributes reasoning to the process.
  await snapshot(`
    {...window.round(30,window.prose('partial first attempt')),stopReason:'error',errorMessage:'provider failed'},
    window.round(40,window.prose('phase after first error')),
    window.round(50,[{type:'toolCall',id:'read-after-error',name:'read',arguments:{path:'later.ts'}}]),
    {...window.round(60,[]),stopReason:'aborted',errorMessage:'Request aborted'},
    window.round(70,window.prose('phase after manual stop')),
    window.round(80,[{type:'thinking',thinking:'final reasoning'},...window.prose('Final answer')])`)
  let state = await read()
  assertClosed(state, 'recovered turn')
  assert.equal(state.groups, 1)
  assert.match(state.tail, /Final answer/)
  assert.match(state.folded, /phase after first error/)
  assert.match(state.folded, /phase after manual stop/)
  assert.deepEqual(state.errors, ['Error', 'Stopped'])
  await capture('turn-errors-folded')
  await toggle()
  state = await read()
  assert.equal(state.hidden, 'false')
  assert.equal(state.inert, false)
  assert.ok(state.height > 0, 'expanding restores the whole process')
  await toggle()
  assertClosed(await read(), 're-collapsed recovered turn')

  // A subagent delivery can trail a completed reply, then be followed by a
  // different execution scope. It must never sit outside every process fold.
  const childMessage = timestamp => ({
    role: 'custom', customType: 'subagent_message', display: true, timestamp, content: 'MODEL_ONLY_CHILD_MESSAGE',
    details: { kind: 'pi-app-subagent-message', sessionId: 'fold-child', runId: 'fold-child-run',
      description: 'Fold regression progress', profile: 'implementer', message: 'A delayed report from the child.', sentAt: '2025-01-01T00:00:03.000Z' }
  })
  const childCompletion = timestamp => ({
    role: 'custom', customType: 'subagent_completion', display: true, timestamp, content: 'MODEL_ONLY_CHILD_COMPLETION',
    details: { subagent: { runId: 'fold-child-run', sessionId: 'fold-child', sessionPath: '/ui/child', parentSessionPath: '/ui/session',
      profile: 'implementer', model: 'fixture', description: 'Fold regression completion', task: 'Check folding', status: 'completed',
      runInBackground: true, createdAt: '2025-01-01T00:00:00.000Z', completedAt: '2025-01-01T00:00:04.000Z' } }
  })
  const assertNoticeOwnership = async (count, label) => {
    const rows = await evaluate(`Array.from(document.querySelectorAll('#turn-fixture [data-subagent-message],#turn-fixture [data-subagent-completion]')).map(row=>{const body=row.closest('[data-turn-process]');return{inside:!!body,hidden:body?.parentElement.getAttribute('aria-hidden'),inert:body?.parentElement.inert}})`)
    assert.equal(rows.length, count, label + ': every notice renders exactly once')
    assert.ok(rows.every(row => row.inside && row.hidden === 'true' && row.inert), label + ': every notice belongs to a collapsed process')
  }
  for (const notice of [childMessage(40), childCompletion(41)]) {
    await snapshot(`window.round(30,window.prose('Completed before notice')),${JSON.stringify(notice)}`, false, false)
    state = await read()
    assertClosed(state, 'trailing ' + notice.customType)
    assert.match(state.tail, /Completed before notice/, 'the completed reply remains outside the fold')
    assert.doesNotMatch(state.tail, /Fold regression/, 'no subagent row leaks below the reply')
    await assertNoticeOwnership(1, notice.customType)
    await toggle()
    assert.equal((await read()).hidden, 'false', 'the notice is accessible by expanding its owning turn')
    if (notice.customType === 'subagent_message') {
      await evaluate(`document.querySelector('#turn-fixture [data-subagent-message] button').click()`)
      await pause(260)
      assert.match((await read()).folded, /A delayed report from the child\./, 'expanding the notice retains its complete payload')
    }
    await toggle()
    await assertNoticeOwnership(1, 're-collapsed ' + notice.customType)
  }
  for (const steer of [false, true]) {
    await snapshot(`window.round(30,window.prose('Completed before notice')),${JSON.stringify(childMessage(40))},${JSON.stringify(childCompletion(41))},
      ${steer ? "{role:'user',timestamp:50,queuedDelivery:'steer',content:'Additional instruction'}," : ''}window.round(60,window.prose('Continuation answer'),'${steer ? 'scope-a' : 'scope-b'}')`, false, false)
    assertClosed(await read(), 'notice before ' + (steer ? 'user steer' : 'new execution scope'))
    assert.equal((await read()).groups, steer ? 1 : 2, 'steers stay with their turn and independent scopes still divide the transcript')
    await assertNoticeOwnership(2, 'notices between execution scopes')
    assert.ok((await read()).folded.indexOf('Fold regression progress') < (await read()).folded.indexOf('Fold regression completion'), 'notice order stays intact inside the fold')
  }
  await snapshot(`window.round(30,window.prose('Reply before wake')),${JSON.stringify(childMessage(40))},
    window.round(50,window.prose('Handling the progress report')),window.round(60,window.prose('Final continuation reply'))`, false, false)
  state = await read()
  assertClosed(state, 'continued child-message wake')
  assert.equal(state.groups, 1, 'the wake and its work share the original fold')
  assert.match(state.folded, /Reply before wake.*Fold regression progress.*Handling the progress report/s)
  assert.match(state.tail, /Final continuation reply/)
  await assertNoticeOwnership(1, 'continued child-message wake')

  await snapshot(JSON.stringify(childMessage(40)), false, false)
  assertClosed(await read(), 'notice-only settled turn')
  await assertNoticeOwnership(1, 'notice-only turn without a following assistant')
  // Live deliveries stay in sequence and remain visible; settlement moves
  // them into the same fold even without another assistant message.
  await snapshot(`window.round(30,window.prose('Live answer')),${JSON.stringify(childMessage(40))}`, true, false)
  assert.equal((await read()).hidden, undefined, 'a live delivery never folds early')
  assert.match((await read()).tail, /Fold regression progress/)
  await evaluate(`window.turnStep({type:'agent_settled'})`)
  await pause(80)
  assertClosed(await read(), 'delivery-only settlement')
  await assertNoticeOwnership(1, 'settled live delivery')
  // Also cover delivery after settlement, and the restored transcript path.
  await snapshot(`window.round(30,window.prose('Reply already settled'))`, false, false)
  await evaluate(`window.turnStep({type:'message_end',message:${JSON.stringify(childMessage(40))}})`)
  await pause(80)
  await assertNoticeOwnership(1, 'late message event')
  await snapshot(`window.round(30,window.prose('Reply already settled')),${JSON.stringify(childMessage(40))}`, false, false)
  await assertNoticeOwnership(1, 'restored late delivery')
  // Q&A answers intentionally render only in their record panel; counting
  // one as process would produce a meaningless duration header with no body.
  await snapshot(`window.round(30,window.prose('Plain answer')),{role:'custom',customType:'ask_user_answer',display:true,timestamp:40,content:'HIDDEN_QA_RECEIPT'}`, false, false)
  assert.equal((await read()).hidden, undefined, 'a hidden Q&A receipt creates no empty fold')
  assert.doesNotMatch((await read()).tail, /HIDDEN_QA_RECEIPT/)
  console.log('PASS: late subagent messages/completions fold exactly once, preserve payload/order across scopes and reopening, remain live until settlement and never expose hidden Q&A receipts.')

  await snapshot(`
    window.round(2000,window.prose('Work before either steer')),
    {role:'user',timestamp:3000,queuedDelivery:'steer',content:'First steering bubble'},
    window.round(5000,window.prose('Work between the steers')),
    {role:'user',timestamp:7000,queuedDelivery:'steer',content:'Second steering bubble'},
    {role:'user',timestamp:8000,queuedDelivery:'steer',content:'Third steering bubble'},
    window.round(10500,window.prose('Work after the last steer')),
    {...window.round(12000,[{type:'thinking',thinking:'Final reasoning'},...window.prose('Answer after both steers')]),completedAt:16010}`)
  await evaluate(`document.documentElement.dataset.compactTools='true';
    window.keptSteers=[...document.querySelectorAll('#turn-fixture [data-turn-steer]')];true`)
  for (const open of [false, true, false]) {
    if (open !== ((await read()).hidden === 'false')) await toggle()
    const steers = await evaluate(`(() => {
      const group = document.querySelector('#turn-fixture [data-assistant-group]');
      const column = group.firstElementChild;
      const rows = [...column.children].filter(row => !row.hidden);
      const bubbles = rows.filter(row => row.hasAttribute('data-turn-steer'));
      const bubbleBounds = row => (row.querySelector(':scope > [data-slot="message-content"] > [data-slot="message-bubble"]') ?? row).getBoundingClientRect();
      const triggers = [...column.querySelectorAll(':scope > [data-transcript-gap-after="divider"] > div > button')];
      const bodies = [...column.querySelectorAll('[data-turn-process]')].map(body => body.parentElement);
      return {
        headers: triggers.map(trigger => trigger.textContent),
        controls: triggers[0].getAttribute('aria-controls').split(' ').length,
        hidden: bodies.map(body => body.inert),
        sharedGroup: bubbles.every(bubble => bubble.parentElement === column),
        sameBubbles: bubbles.every((bubble,index) => bubble === window.keptSteers[index]),
        gaps: bubbles.map(row => {
          const index = rows.indexOf(row);
          const bubble = bubbleBounds(row);
          return [bubble.top - bubbleBounds(rows[index-1]).bottom, bubbleBounds(rows[index+1]).top - bubble.bottom];
        }),
        clearance: bubbles.flatMap(row => {
          const next = rows[rows.indexOf(row)+1];
          if (!next.hasAttribute('data-turn-steer')) return [];
          const button = row.querySelector('[data-message-actions="overlay"] button').getBoundingClientRect();
          return [[button.top - bubbleBounds(row).bottom, bubbleBounds(next).top - button.bottom]];
        }),
        order: rows.map(row => row.textContent).join(' '),
      };
    })()`)
    assert.deepEqual(steers.headers, ['Took 16s'], 'the steers share the original prompt-to-reply duration')
    assert.equal(steers.controls, steers.hidden.length, 'the only trigger announces every controlled process section')
    assert.ok(steers.hidden.every(value => value === !open), 'every folded process section follows the same trigger')
    assert.equal(steers.sharedGroup && steers.sameBubbles, true, 'steers remain visible in the same DOM nodes while toggling')
    assert.deepEqual(steers.gaps, open ? [[24,24],[24,36],[36,24]] : [[24,36],[36,36],[36,24]],
      'consecutive bubbles have room for actions, including across a folded process section')
    assert.deepEqual(steers.clearance, open ? [[6,6]] : [[6,6],[6,6]], 'action buttons have equal clearance from both bubbles')
    assert.match(steers.order, open
      ? /Work before either steer.*First steering bubble.*Work between the steers.*Second steering bubble.*Third steering bubble.*Answer after both steers/s
      : /First steering bubble.*Second steering bubble.*Third steering bubble.*Answer after both steers/s)
    await capture(open ? 'turn-steers-expanded' : 'turn-steers-folded')
  }
  await evaluate(`document.documentElement.dataset.compactTools='false'`)
  console.log('PASS: multiple steers stay visible with room for actions between adjacent bubbles, preserved order and one elapsed-time disclosure.')

  // With no completed reply, even partial prose is process. Include both a
  // contentless terminal round and a stop/error on the prose's own round.
  for (const reason of ['error', 'aborted']) {
    for (const partial of [false, true]) {
      await snapshot(`window.round(30,window.prose('phase before interruption')),
        {...window.round(40,${partial ? "window.prose('partial answer')" : '[]'}),stopReason:'${reason}',errorMessage:'interrupted detail'}`)
      state = await read()
      assertClosed(state, reason + ' with partial=' + partial, reason === 'aborted')
      assert.deepEqual(state.errors, reason === 'error' ? ['Error'] : [])
      assert.ok(state.actions.includes('Continue response'), 'Continue stays accessible outside the fold')
      assert.ok(state.actions.includes('Retry response'), 'Retry stays accessible outside the fold')
      assert.ok(state.actions.includes('Fork from here'), 'Fork stays accessible outside the fold')
    }
  }

  await snapshot(`{...window.round(30,[]),stopReason:'error',errorMessage:'only error'}`, false, false)
  state = await read()
  assertClosed(state, 'error-only turn')
  assert.deepEqual(state.errors, ['Error'], 'an error by itself is real fold content')

  // Compare with a real completed reply's footer, not with the process-row gap.
  await snapshot(`window.round(20,window.prose('Earlier investigation')),
    window.round(30,window.prose('Normal completed reply'))`, false, false)
  await pause(260)
  const textSpacing = await evaluate(`(() => {
    const column = document.querySelector('#turn-fixture [data-assistant-group] [data-slot="message-content"]');
    const reply = column.querySelector(':scope > [data-row="text"]');
    const response = reply.querySelector('[data-state="complete"][aria-busy="false"]');
    const content = response.querySelector('[aria-live]');
    const actions = response.querySelector('[data-message-actions]');
    return {
      divider: reply.getBoundingClientRect().top - reply.previousElementSibling.getBoundingClientRect().bottom,
      action: actions.querySelector('button').getBoundingClientRect().top - content.getBoundingClientRect().bottom,
      glyph: actions.querySelector('button svg').getBoundingClientRect().top - content.getBoundingClientRect().bottom
    };
  })()`)
  const replyActionGap = textSpacing.action
  assert.equal(textSpacing.divider, 24, 'normal text uses a 24px divider gap')
  assert.equal(replyActionGap, 12, 'normal replies use a 12px footer gap')

  // Compare every ending with actual normal text, including the visible icon
  // boxes. A 24px wrapper gap or a shorter standalone button used to make the
  // same retry/fork glyphs drift depending on the preceding content.
  const endings = [
    { name: 'text', rounds: "window.round(30,window.prose('Completed reply'))", write: false },
    { name: 'text with files', rounds: "window.round(30,window.prose('Completed reply'))", write: true },
    { name: 'files without text', rounds: '', write: true },
    { name: 'tools without text', rounds: "window.round(30,[{type:'toolCall',id:'read-final',name:'read',arguments:{path:'x.ts'}}])", write: false },
    { name: 'stopped with files', rounds: "{...window.round(30,[]),stopReason:'aborted',errorMessage:'Request aborted'}", write: true },
    { name: 'error with files', rounds: "{...window.round(30,[]),stopReason:'error',errorMessage:'provider failed'}", write: true }
  ]
  for (const corners of ['square', 'squircle']) for (const compact of [false, true]) {
    await evaluate(`document.documentElement.dataset.corners='${corners}';document.documentElement.dataset.compactTools='${compact}'`)
    for (const ending of endings) {
      await snapshot(ending.rounds, false, ending.write)
      await pause(260)
      const spacing = await evaluate(`(() => {
        const group = document.querySelector('#turn-fixture [data-assistant-group]');
        const actions = group.querySelector('[data-message-actions]');
        let boundary = actions;
        while (!boundary.previousElementSibling) boundary = boundary.parentElement;
        const bottom = boundary.previousElementSibling.getBoundingClientRect().bottom;
        const section = group.querySelector('[data-transcript-gap-after="divider"]');
        const next = section?.nextElementSibling;
        return {
          action: actions.querySelector('button').getBoundingClientRect().top - bottom,
          glyph: actions.querySelector('button svg').getBoundingClientRect().top - bottom,
          divider: next && next.getAttribute('data-transcript-gap-before') !== 'actions'
            ? next.getBoundingClientRect().top - section.getBoundingClientRect().bottom : null
        };
      })()`)
      const label = ending.name + '/' + corners + '/' + compact
      assert.equal(spacing.action, textSpacing.action, label + ': button gap matches normal text')
      assert.equal(spacing.glyph, textSpacing.glyph, label + ': visible glyph gap matches normal text')
      if (spacing.divider !== null) assert.equal(spacing.divider, textSpacing.divider, label + ': divider gap matches normal text')
    }
  }

  // Stop keeps the 24px leading process gap, but its action footer uses the
  // normal reply's 12px gap. Neither follows the compact process-row setting.
  await snapshot(`window.round(30,window.prose('phase before interruption')),
    {...window.round(40,[]),stopReason:'aborted',errorMessage:'Request aborted'}`, false, false)
  for (const compact of [false, true]) {
    await evaluate(`document.documentElement.dataset.compactTools='${compact}'`)
    for (const open of [false, true]) {
      if (open) await toggle()
      const gaps = await evaluate(`(() => {
        const column = document.querySelector('#turn-fixture [data-assistant-group] [data-slot="message-content"]');
        const ending = column.querySelector(':scope > [data-turn-ending]');
        const stop = ending.firstElementChild;
        const actions = stop.nextElementSibling;
        return {
          before: ending.getBoundingClientRect().top - ending.previousElementSibling.getBoundingClientRect().bottom,
          after: actions.getBoundingClientRect().top - stop.getBoundingClientRect().bottom,
        };
      })()`)
      assert.deepEqual(gaps, { before: 24, after: replyActionGap }, 'regular stop/action gaps: compact=' + compact + ', open=' + open)
      if (!open) await capture('turn-stopped-' + (compact ? 'compact' : 'regular'))
      if (open) await toggle()
    }
  }
  await evaluate(`document.documentElement.dataset.compactTools='false'`)

  // An in-flight retry remains fully visible, then folds at agent_settled.
  await snapshot(`{...window.round(30,[]),stopReason:'error',errorMessage:'retry error'},
    window.round(40,window.prose('phase during retry'))`, true)
  assert.equal((await read()).hidden, undefined, 'a live retry never folds')
  assert.match((await read()).tail, /Error.*phase during retry/)
  await evaluate(`window.turnStep({type:'message_end',message:window.round(50,window.prose('Final answer'))});
    window.turnStep({type:'agent_settled'},1)`)
  await pause(80)
  assertClosed(await read(), 'settled retry')

  // Auto-retry can deliver an old error after the final reply was restored.
  await evaluate(`window.turnStep({type:'message_end',message:{...window.round(25,[]),stopReason:'error',errorMessage:'late error'}},1)`)
  await pause(80)
  state = await read()
  assertClosed(state, 'late error')
  assert.equal(state.errors.length, 2)
  assert.match(state.tail, /Final answer/)
  console.log('PASS: whole-turn folding contains errors, earlier stops, later process, partial output and late retry events; terminal Stop/actions keep regular gaps in compact mode and live turns stay expanded.')
}
