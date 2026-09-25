import assert from 'node:assert/strict'

/** Exercise the real ChatView/PiStore and beUI disclosures, including snapshots
 * and the live → settled transition. No model calls or persisted user data. */
export async function checkTurnFoldUi(evaluate, pause, capture = async () => {}) {
  await evaluate(`window.startTurnFixture();
    window.foldRead = () => {
      const group = document.querySelector('#turn-fixture [data-assistant-group]');
      const column = group.querySelector('[data-slot="message-content"]');
      const body = group.querySelector('[data-turn-process]');
      return {
        groups: document.querySelectorAll('#turn-fixture [data-assistant-group]').length,
        folded: body?.textContent ?? '',
        tail: [...column.children].filter(row => !body || !row.contains(body)).map(row => row.textContent).join(' '),
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
