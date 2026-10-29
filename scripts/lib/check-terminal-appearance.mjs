import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const luminance = hex => {
  const channels = hex.match(/[a-f\d]{2}/gi).map(c => parseInt(c, 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

/** Called by check-terminal.mjs with its real, isolated Electron + PTY. */
export async function checkTerminalAppearance({ evaluate, send, input, waitFor, click, pause, ws, temporary, first, second }) {
  const chromatic = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']
  const write = data => evaluate(`new Promise(r=>terminal().write(${JSON.stringify(data)},r))`)
  const samples = [
    'Normal text / default background',
    '\x1b[2mDim text\x1b[0m   \x1b[1mBold text\x1b[0m',
    '\x1b[7m Inverse selection \x1b[0m',
    '\x1b[37;44m ANSI background selection \x1b[0m',
    ...[0, 60].map(offset => chromatic.map((name, i) => `\x1b[${31 + i + offset}m${name.padEnd(8)}\x1b[0m`).join('')),
    '\x1b[38;5;39m256 color\x1b[0m  \x1b[38;2;87;105;247mRGB color\x1b[0m',
    'Mouse selection: colored text and backgrounds',
    '\x1b[31mRed text\x1b[0m  \x1b[37;41mRed background\x1b[0m  plain text'
  ].join('\r\n')
  await write('\x1b[0m\x1b[2J\x1b[H' + samples)
  for (const dark of [false, true]) {
    await evaluate(`document.documentElement.classList.toggle('dark',${dark})`)
    await pause(120)
    const palette = await evaluate('terminal().options.theme')
    const scheme = dark ? 'dark' : 'light'
    for (const name of [...chromatic, ...chromatic.map(n => 'bright' + n[0].toUpperCase() + n.slice(1)), 'brightBlack']) {
      assert.ok(contrast(palette[name], palette.background) >= 4.5, `${scheme} ${name} text contrast`)
    }
    assert.ok(contrast(palette.foreground, palette.background) >= 7, `${scheme} normal text contrast`)
    assert.ok(contrast(palette.cursor, palette.background) >= 7, `${scheme} cursor contrast`)
    assert.ok(contrast(palette.black, palette.white) >= 7, `${scheme} literal black/white ANSI pair`)
    for (const background of ['selectionBackground', 'selectionInactiveBackground']) {
      assert.ok(contrast(palette.selectionForeground, palette[background]) >= 4.5, `${scheme} ${background} text`)
      assert.ok(contrast(palette[background], palette.background) >= 3, `${scheme} ${background} visibility`)
    }
    // UI accents cannot turn shell status colors into different meanings or
    // trigger needless atlas rebuilds (font changes are checked by the caller).
    await evaluate('window.savedTerminalTheme=terminal().options.theme')
    for (const accent of ['indigo', 'blue', 'violet', 'emerald', 'amber', 'rose', 'cyan']) {
      await evaluate(`document.documentElement.dataset.accent=${JSON.stringify(accent)}`)
      await pause(20)
      assert.equal(await evaluate('terminal().options.theme === savedTerminalTheme'), true, 'accent preserves terminal theme identity')
    }
    await evaluate(`terminal().select(0,terminal().buffer.active.baseY+8,42);terminal().focus()`)
    await pause(80)
    if (process.env.TERMINAL_SCREENSHOT_DIR) {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(process.env.TERMINAL_SCREENSHOT_DIR, `terminal-palette-${scheme}.png`), Buffer.from(shot.data, 'base64'))
    }
    await evaluate('terminal().clearSelection()')
  }
  await evaluate("document.documentElement.dataset.accent='indigo'")
  console.log('PASS: light/dark ANSI, inverse, cursor, active/inactive selection contrast; all UI accents')

  // Actual PTY round trip, with the probe in raw mode to prevent its shell from
  // treating terminal replies as commands. No model, credentials or user config.
  const replies = join(temporary, 'color-replies.txt')
  const probe = join(temporary, 'color-probe.mjs')
  await writeFile(replies, '')
  await writeFile(probe, `import {appendFileSync} from 'node:fs';
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',data=>{
 const key=data.toString();
 if(key==='q')process.stdout.write('\\x1b]10;?\\x07\\x1b]11;?\\x07\\x1b[?2031$p\\x1b[?996n');
 else if(key==='e')process.stdout.write('\\x1b[?2031;25h');
 else if(key==='d')process.stdout.write('\\x1b[?2031l');
 else if(key==='r')process.stdout.write('\\x1bc');
 else if(key==='s')process.stdout.write('\\x1b[!p');
 else if(key==='\\x03'){process.stdin.setRawMode(false);process.exit(0)}
 else appendFileSync(${JSON.stringify(replies)},data);
});process.stdout.write('\\r\\n__COLOR_PROBE_READY__\\r\\n');`)
  await input(`${quote(process.execPath)} ${quote(probe)}\r`)
  await waitFor('traffic[tc.getSnapshot().active].tail.includes("__COLOR_PROBE_READY__")', 'color probe')
  const expectReply = async expected => {
    for (let i = 0; i < 100; i++) {
      if ((await readFile(replies, 'utf8')).includes(expected)) return
      await pause(20)
    }
    assert.fail(`missing terminal reply ${JSON.stringify(expected)}; received ${JSON.stringify(await readFile(replies, 'utf8'))}`)
  }
  const osc = hex => 'rgb:' + hex.slice(1).match(/../g).map(channel => channel.repeat(2)).join('/')
  await input('q')
  let palette = await evaluate('terminal().options.theme')
  await expectReply(`\x1b]10;${osc(palette.foreground)}\x1b\\`)
  await expectReply(`\x1b]11;${osc(palette.background)}\x1b\\`)
  await expectReply('\x1b[?2031;2$y')
  await expectReply('\x1b[?997;1n')
  await input('e'); await pause(80); await input('q')
  await expectReply('\x1b[?2031;1$y')
  await writeFile(replies, '')
  await evaluate("document.documentElement.classList.remove('dark')")
  await expectReply('\x1b[?997;2n')
  await input('q')
  palette = await evaluate('terminal().options.theme')
  await expectReply(`\x1b]11;${osc(palette.background)}\x1b\\`)
  await writeFile(replies, '')
  await click(`[data-terminal-tab="${second}"] [role="tab"]`)
  await evaluate("document.documentElement.classList.add('dark')")
  await expectReply('\x1b[?997;1n')
  await click(`[data-terminal-tab="${first}"] [role="tab"]`)
  for (const reset of ['d', 'r', 's']) {
    await input('e'); await pause(60); await input(reset); await pause(60)
    await writeFile(replies, '')
    await evaluate("document.documentElement.classList.toggle('dark')")
    await pause(100)
    assert.equal(await readFile(replies, 'utf8'), '', 'no unsolicited replies after disable/reset')
  }
  await input('\x03'); await input('printf "__COLOR_PROBE_DONE__\\n"\r')
  await waitFor('traffic[tc.getSnapshot().active].tail.includes("\\r\\n__COLOR_PROBE_DONE__\\r\\n")', 'probe shutdown')
  console.log('PASS: OSC 10/11, mode 2031 query/subscribe/reset, background terminal theme updates')

  // Capture compositor frames while actually dragging the panel. Looking only
  // at xterm's onRender would miss the blank interval before that event.
  if (process.env.TERMINAL_RESIZE_BASELINE) {
    // Negative control: reproduce the former clear/resize/rAF implementation.
    await evaluate(`(()=>{const r=tc.sessions.get(tc.getSnapshot().active).runtime;r.sizing.schedule=()=>{requestAnimationFrame(()=>{if(r.element.isConnected)r.fit.fit()})}})()`)
  }
  await evaluate("document.documentElement.classList.remove('dark');terminal().options.cursorBlink=false")
  await pause(80)
  await write('\x1b[0m\x1b[2J\x1b[H\x1b[34m' + Array.from({ length: 80 }, () => 'M'.repeat(110)).join('\r\n') + '\x1b[0m')
  await pause(150)
  const crop = await evaluate(`(()=>{const r=document.querySelector('[data-terminal-surface]').getBoundingClientRect();return {x:r.x+10,y:r.y+10,width:Math.min(160,r.width-20),height:120}})()`)
  const handle = await evaluate(`(()=>{const r=document.querySelector('[data-panel-handle="left"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+150}})()`)
  const viewport = await evaluate('({width:innerWidth,height:innerHeight})')
  const frames = []
  const capture = event => {
    const message = JSON.parse(event.data)
    if (message.method !== 'Page.screencastFrame') return
    frames.push(message.params.data)
    void send('Page.screencastFrameAck', { sessionId: message.params.sessionId })
  }
  ws.addEventListener('message', capture)
  await send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...handle, button: 'left', clickCount: 1 })
  for (let step = 1; step <= 48; step++) {
    const travel = step <= 24 ? step * 4 : (48 - step) * 4
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x - travel, y: handle.y, button: 'left', buttons: 1 })
    await pause(12)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...handle, button: 'left', clickCount: 1 })
  await pause(200)
  await send('Page.stopScreencast')
  ws.removeEventListener('message', capture)
  const background = (await evaluate('terminal().options.theme.background')).slice(1).match(/../g).map(channel => parseInt(channel, 16))
  const ink = []
  for (const frame of frames) {
    ink.push(await evaluate(`(async()=>{
      const bitmap=await createImageBitmap(await(await fetch('data:image/png;base64,${frame}')).blob());
      const c=document.createElement('canvas');c.width=${crop.width};c.height=${crop.height};const ctx=c.getContext('2d');
      const sx=bitmap.width/${viewport.width},sy=bitmap.height/${viewport.height};
      ctx.drawImage(bitmap,${crop.x}*sx,${crop.y}*sy,${crop.width}*sx,${crop.height}*sy,0,0,c.width,c.height);bitmap.close();
      const pixels=ctx.getImageData(0,0,c.width,c.height).data,bg=${JSON.stringify(background)};let ink=0;
      for(let i=0;i<pixels.length;i+=4)if(Math.max(...bg.map((v,j)=>Math.abs(pixels[i+j]-v)))>50)ink++;
      return ink/(c.width*c.height);
    })()`))
  }
  assert.ok(frames.length >= 8, 'captured multiple compositor frames during drag')
  assert.ok(ink.every(value => value > 0.01), `resize has no blank frames: ${JSON.stringify(ink)}`)
  assert.equal(await evaluate('document.querySelectorAll("[data-terminal-resize-cover]").length'), 0, 'resize cover removed after final render')
  await evaluate('terminal().options.cursorBlink=true')
  console.log('PASS: panel drag retains text in all', frames.length, 'compositor frames; minimum ink', Math.min(...ink).toFixed(3))

  if (process.env.TERMINAL_CLAUDE_BIN) {
    const config = join(temporary, 'claude-theme-check')
    await mkdir(config)
    await writeFile(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'auto' }))
    // Bare mode skips keychain/hooks/plugins; a dummy credential + loopback
    // endpoint prevents any real API use. No prompt is ever submitted.
    const command = `CLAUDE_CONFIG_DIR=${quote(config)} CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 ANTHROPIC_API_KEY=terminal-theme-test ANTHROPIC_BASE_URL=http://127.0.0.1:9 ${quote(process.env.TERMINAL_CLAUDE_BIN)} --bare --settings '{"theme":"auto"}' --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-chrome`
    await input(`clear; ${command}; printf '\\n__CLAUDE_PROCESS_DONE__\\n'\r`)
    await pause(3000)
    // This version may still ask for workspace trust or the dummy API key.
    const screen = await evaluate('buffer().slice(-4500)')
    if (screen.includes('Yes, I trust this folder')) { await input('\r'); await pause(1800) }
    if ((await evaluate('buffer().slice(-3500)')).includes('Do you want to use this API key?')) {
      await input('\x1b[A\r'); await pause(2000)
    }
    await input('/')
    const hasSuggestion = rgb => `(()=>{const b=terminal().buffer.active;for(let y=b.viewportY;y<b.length;y++){const line=b.getLine(y);if(!line.translateToString(true).includes('/'))continue;for(let x=0;x<terminal().cols;x++){const c=line.getCell(x);if(c.isFgRGB()&&c.getFgColor()===${rgb}&&c.getChars().trim())return true}}return false})()`
    await waitFor(hasSuggestion(0x5769f7), 'Claude auto uses light selection RGB', 12000)
    for (const [dark, rgb] of [[false, 0x5769f7], [true, 0xb1b9f9], [false, 0x5769f7]]) {
      await evaluate(`document.documentElement.classList.toggle('dark',${dark})`)
      await waitFor(hasSuggestion(rgb), 'Claude auto follows terminal theme notification', 5000)
      if (process.env.TERMINAL_SCREENSHOT_DIR) {
        await pause(120)
        const shot = await send('Page.captureScreenshot', { format: 'png' })
        await writeFile(join(process.env.TERMINAL_SCREENSHOT_DIR, `terminal-claude-${dark ? 'dark' : 'light'}.png`), Buffer.from(shot.data, 'base64'))
      }
    }
    // A first Ctrl-C clears the draft/menu, then the double press exits. The
    // shell's marker is a reliable completion boundary; a title reset isn't.
    await input('\x03'); await pause(250); await input('\x03'); await pause(250); await input('\x03')
    await waitFor('traffic[tc.getSnapshot().active].tail.includes("\\r\\n__CLAUDE_PROCESS_DONE__\\r\\n")', 'Claude shutdown', 20000)
    console.log('PASS: real Claude Code Auto menu selection follows light/dark/light without restart')
  }
}
