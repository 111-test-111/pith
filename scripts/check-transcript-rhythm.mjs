/** Real ChatView geometry in isolated Electron (no SDK/model calls).
 * Checks both densities, nested disclosures, prose boundaries, images and
 * output caps, plus commit-frame stability with animations disabled.
 * PI_TRANSCRIPT_SCREENSHOT_DIR retains screenshots. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-rhythm-'))
const fixturePath = '/__transcript_rhythm_check.html'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Shared positive gaps and content row height from styles.css. */
const ROW_GAP = 24
const ROW_HEIGHT = 24

/**
 * A colour-bar PNG, built here so the fixture carries a CAPTURE-SIZED image.
 * Bands rather than a flat fill: a screenshot of a flat rectangle cannot show
 * whether an image is contained, capped or cropped, and a 1×1 pixel cannot
 * either. The 16:9 shape is what the assertions pin.
 */
function capturePngBytes(width, height) {
  const band = (x) => BANDS[Math.min(BANDS.length - 1, Math.floor((x / width) * BANDS.length))]
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const start = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      // A left-to-right shade ramp makes the caps and the aspect ratio visible.
      const shade = 0.55 + 0.45 * (x / width)
      const [red, green, blue] = band(x)
      raw[start + 1 + x * 3] = Math.round(red * shade)
      raw[start + 2 + x * 3] = Math.round(green * shade)
      raw[start + 3 + x * 3] = Math.round(blue * shade)
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const BANDS = [
  [214, 96, 77],
  [224, 145, 60],
  [232, 197, 71],
  [138, 176, 90],
  [86, 156, 214],
  [92, 118, 196],
  [140, 98, 190],
  [196, 96, 150]
]
const capturePng = capturePngBytes(1600, 900).toString('base64')

const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ChatView} from '/src/components/app/ChatView.tsx';
import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';
import {PiStore} from '/src/state/pi-store.ts';
import {I18nProvider} from '/src/i18n/index.tsx';
import {initReduceMotion, setReduceMotion} from '/src/lib/reduce-motion.ts';
import {initCompactTools, setCompactTools} from '/src/lib/compact-tools.ts';
import {initFontSizes} from '/src/lib/typography.ts';
import {initFonts} from '/src/lib/fonts.ts';
import '/src/styles.css';
const params = new URLSearchParams(location.search);
localStorage.setItem('pi-app:locale', params.get('locale') ?? 'en');
localStorage.setItem('pi-app:font-sizes', JSON.stringify({ui:Number(params.get('ui') ?? 14),content:14,code:12}));
initFontSizes();initFonts();
if (params.has('font')) document.documentElement.style.setProperty('--app-font-ui', params.get('font')+', sans-serif');
const caseName = params.get('case') ?? 'invisible';
document.documentElement.classList.toggle('dark', params.has('dark'));
document.documentElement.dataset.corners = params.get('style') ?? 'square';
// The reported turn had "show reasoning blocks" off, so a round's reasoning is
// not a row; the third case turns it back on to prove the same rhythm holds
// when reasoning rows alternate with tool rows.
localStorage.setItem('pi-app:show-reasoning', caseName === 'reasoning' || caseName === 'images' || caseName === 'compact' || caseName === 'compaction' ? 'on' : 'off');
// Compact consecutive tool calls is read from storage at boot; the fixture boots it the
// way main.tsx does, so the real html[data-compact-tools] CSS is what runs.
localStorage.setItem('pi-app:compact-tools', params.get('compact') === '1' ? 'on' : 'off');
initCompactTools();
localStorage.setItem('pi-app:reduce-motion', params.get('instant') === '1' ? 'on' : 'off');
localStorage.setItem('pi-app:tool-grouping', params.get('grouping') === '0' ? 'off' : 'on');
initReduceMotion();
window.setDensity = setCompactTools;
window.setInstant = (value) => flushSync(() => setReduceMotion(value));


window.pi = { openPath: async (path) => { window.__opened = path; return ''; }, appInfo: async () => ({ version: 'fixture' }), openExternal: async () => {},
  onBashTask: () => () => {}, listBashTasks: async () => [], onSubagents: () => () => {}, appInfoSync: null };

const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args ?? {} });
const result = (id, name, timestamp) => ({ role: 'toolResult', toolCallId: id, toolName: name, timestamp, content: [{ type: 'text', text: 'ok' }], isError: false });
const richResult = (id, name, timestamp, content, isError) => ({ role: 'toolResult', toolCallId: id, toolName: name, timestamp, content, isError: isError === true });
/** A result that carries a unified patch, so edit/write render a FileDiff. */
const patchResult = (id, name, timestamp, patch) => ({ role: 'toolResult', toolCallId: id, toolName: name, timestamp, content: [{ type: 'text', text: 'ok' }], isError: false, details: { patch } });
const PATCH = [
  'diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css',
  '--- a/src/renderer/src/styles.css',
  '+++ b/src/renderer/src/styles.css',
  '@@ -1,2 +1,3 @@',
  ' @import "tailwindcss";',
  '+/* native highlights */',
  ' ::highlight(x) {',
  '-  color: red;',
  '+  color: blue;',
  ' }'
].join('\\n');
/** A 1600×900 capture — the image payload a read/screenshot tool result carries. */
const IMAGE = { type: 'image', data: '${capturePng}', mimeType: 'image/png' };
const thinking = (text) => ({ type: 'thinking', thinking: text });
const round = (timestamp, content) => ({ role: 'assistant', timestamp, content, changeScopeId: 'scope-a', stopReason: content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop' });

// Rounds arrive as separate assistant messages; the reported turn opened every
// round with a one-space text part in front of its hidden reasoning.
const invisibleTurn = [
  { role: 'user', timestamp: 1, content: 'go' },
  round(10, [{ type: 'text', text: ' ' }, thinking('plan'), call('t1', 'todo_write')]),
  result('t1', 'todo_write', 11),
  round(20, [{ type: 'text', text: ' ' }, thinking('look'), call('g1', 'grep'), call('f1', 'find')]),
  result('g1', 'grep', 21), result('f1', 'find', 22),
  round(30, [{ type: 'text', text: ' ' }, thinking('look more'), call('r1', 'read'), call('g2', 'grep')]),
  result('r1', 'read', 31), result('g2', 'grep', 32)
];
// A real prose block between two tool rounds: the rows stay separate, and they
// must still sit on the same rhythm as everything else.
const visibleTurn = [
  { role: 'user', timestamp: 1, content: 'go' },
  round(10, [call('e1', 'edit'), call('b1', 'bash')]),
  result('e1', 'edit', 11), result('b1', 'bash', 12),
  round(20, [{ type: 'text', text: 'The fix is in. Now I will verify it.' }, call('b2', 'bash')]),
  result('b2', 'bash', 21),
  round(30, [{ type: 'text', text: ' ' }, call('r1', 'read'), call('r2', 'read'), call('r3', 'read')]),
  result('r1', 'read', 31), result('r2', 'read', 32), result('r3', 'read', 33)
];
// The reported trio: a read row, a bash row and a three-call exploration
// GROUP row, all in one merged run — the exact shape whose row gaps were
// reported as unequal.
const mixedTurn = [
  { role: 'user', timestamp: 1, content: 'go' },
  round(10, [call('r1', 'read')]),
  result('r1', 'read', 11),
  round(20, [call('b1', 'bash')]),
  result('b1', 'bash', 21),
  round(30, [call('r2', 'read'), call('r3', 'read'), call('r4', 'read')]),
  result('r2', 'read', 31), result('r3', 'read', 32), result('r4', 'read', 33)
];
// A tool whose output IS an image: the SDK's read tool inlines an image file
// and browser_screenshot returns a capture, each beside its own bookkeeping text
// (and the screenshot's own notes). The same read tool also reads a text file,
// which keeps the framed output box.
const imageTurn = [
  { role: 'user', timestamp: 1, content: 'look at this' },
  round(10, [call('r1', 'read', { path: 'docs/shot.png' }), call('s1', 'browser_screenshot')]),
  richResult('r1', 'read', 11, [{ type: 'text', text: 'Read image file [image/png]' }, IMAGE]),
  richResult('s1', 'browser_screenshot', 12, [IMAGE, { type: 'text', text: '[Targeted by selector button in frame #0.]' }]),
  round(20, [thinking('checked the capture'), call('g1', 'grep')]),
  result('g1', 'grep', 21),
  round(30, [{ type: 'text', text: 'The capture shows the toolbar.' }, call('r2', 'read', { path: 'src/app.ts' })]),
  result('r2', 'read', 31)
];
// A tool result whose image did NOT come back cleanly: an errored result that
// still carries its image, and one whose image bytes cannot be decoded. The text
// beside the image is the tool's diagnosis there — the one case where hiding it
// loses information — so the row keeps it (and drops an undecodable image rather
// than leaving a broken icon behind).
const BROKEN = { type: 'image', data: 'bm90LWFuLWltYWdl', mimeType: 'image/png' };
const imageFailureTurn = [
  { role: 'user', timestamp: 1, content: 'read it' },
  round(10, [call('r1', 'read', { path: 'docs/err.png' })]),
  richResult('r1', 'read', 11, [{ type: 'text', text: 'Read image file [image/png]' }, IMAGE], true),
  round(20, [{ type: 'text', text: 'That one came back with an error.' }, call('r2', 'read', { path: 'docs/broken.png' })]),
  richResult('r2', 'read', 21, [{ type: 'text', text: 'could not decode the image' }, BROKEN]),
  round(30, [{ type: 'text', text: 'Done.' }, call('g1', 'grep')]),
  result('g1', 'grep', 31)
];
// A long tool output: the card caps its body, so the fold has to land on a LINE
// boundary instead of slicing one in half.
const longTurn = [
  { role: 'user', timestamp: 1, content: 'list it' },
  round(10, [call('b1', 'bash')]),
  richResult('b1', 'bash', 11, [{ type: 'text', text: Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1)).join('\\n') }]),
  round(20, [call('g1', 'grep')]),
  result('g1', 'grep', 21)
];
// Compact consecutive tool calls: a turn whose rows alternate process → process pairs
// with a prose row between them. Reasoning rows count as process rows too.
const compactTurn = [
  { role: 'user', timestamp: 1, content: 'go' },
  round(10, [thinking('plan'), call('e1', 'edit'), call('b1', 'bash')]),
  result('e1', 'edit', 11), result('b1', 'bash', 12),
  round(20, [{ type: 'text', text: 'Verifying the change now.' }, thinking('check'), call('g1', 'grep'), call('b2', 'bash')]),
  result('g1', 'grep', 21), result('b2', 'bash', 22)
];
// A steer-delivered notice: the parent model's steering data painted as a quiet
// tool row ("Subagent completed" / "Task finished" / a running subagent's message). It sits
// BETWEEN tool rounds; every kind shares their row geometry and spacing.
const subagentNotice = (timestamp) => ({
  role: 'custom', customType: 'subagent_message', display: true, timestamp, content: '',
  details: { kind: 'pi-app-subagent-message', sessionId: 'sub-1', description: 'explore', profile: 'explore', message: 'Halfway through the reads.', sentAt: new Date(0).toISOString() }
});
const noticeTurn = [
  { role: 'user', timestamp: 1, content: 'go' },
  round(10, [call('e1', 'edit')]),
  result('e1', 'edit', 11),
  subagentNotice(12),
  { role: 'custom', customType: 'subagent_completion', display: true, timestamp: 13, content: '', details: { subagent: {
    runId: 'run-1', sessionId: 'child-1', sessionPath: '/ui/child', parentSessionPath: '/ui/rhythm', profile: 'explore', model: 'fixture',
    description: 'Inspect module', task: 'Inspect module', status: 'completed', runInBackground: true,
    createdAt: new Date(0).toISOString(), completedAt: new Date(1000).toISOString(), tokens: 100, toolUses: 2, result: 'Inspection complete.'
  } } },
  { role: 'custom', customType: 'bash_task_completion', display: true, timestamp: 14, content: '', details: { bashTask: {
    id: 'task-1', toolCallId: 'background-1', sessionPath: '/ui/rhythm', command: 'echo finished', cwd: '/ui', status: 'succeeded',
    background: true, startedAt: 0, endedAt: 1000, outputChars: 0, exitCode: 0, revision: 1
  } } },
  round(20, [call('b1', 'bash')]),
  result('b1', 'bash', 21)
];
// The Figure-2 shape: a group whose LAST row is expanded, followed by another
// process row (the next group's header), plus an edit whose patch renders a
// FileDiff — the one tool body that is its own card rather than a child of
// data-tool-body.
const groupOpenTurn = [
  { role: 'user', timestamp: 1, content: 'go' },
  round(10, [call('g1', 'grep'), call('r1', 'read', { path: 'src/renderer/src/lib/tool-runs.ts' })]),
  result('g1', 'grep', 11),
  result('r1', 'read', 12),
  round(20, [call('e1', 'edit', { path: 'src/renderer/src/styles.css' })]),
  patchResult('e1', 'edit', 21, PATCH),
  round(30, [call('b1', 'bash'), call('b2', 'bash')]),
  result('b1', 'bash', 31), result('b2', 'bash', 32)
];
const boundaryTurn = [
  { role: 'user', timestamp: 1, content: 'go' },
  round(10, [{ type: 'text', text: 'A complete answer.' }]),
  { role: 'compactionSummary', timestamp: 20, summary: 'A compact summary.', tokensBefore: 1000 },
  { role: 'bashExecution', timestamp: 30, command: 'echo ok', output: 'ok', exitCode: 0, cancelled: false },
  { role: 'user', timestamp: 40, content: 'Continue.' },
  round(50, [call('e1', 'edit')]), result('e1', 'edit', 51)
];
// A long process followed by a short reply: the real tool statuses include
// positioned screen-reader text, which must stay inside the closed fold's
// clip even when reduced motion removes the disclosure's transform.
const longFoldTurn = [
  { role: 'user', timestamp: 1, content: 'Verify all steps.' },
  ...Array.from({ length: 40 }, (_, index) => {
    const timestamp = 10 + index;
    const id = 'fold-' + index;
    return [
      round(timestamp, [{ type: 'text', text: 'Verifying step ' + index + '.' }, call(id, 'bash', { command: 'echo step-' + index })]),
      result(id, 'bash', timestamp + 0.5)
    ];
  }).flat()
];
const turns = { longFold: longFoldTurn, boundary: boundaryTurn, leadingProse: [visibleTurn[0], round(5, [{ type: 'text', text: 'Starting with a plan.' }]), ...visibleTurn.slice(1)], invisible: invisibleTurn, visible: visibleTurn, reasoning: invisibleTurn, mixed: mixedTurn, images: imageTurn, failure: imageFailureTurn, long: longTurn, compact: compactTurn, compaction: compactTurn, notice: noticeTurn, groupOpen: groupOpenTurn };
const messages = turns[caseName] ?? invisibleTurn;
if (params.has('settled')) messages.push(round(60, [{ type: 'text', text: 'All done.' }]));

window.store = new PiStore();
window.store.applySnapshot({ sessionId: 'rhythm', sessionPath: '/ui/rhythm', cwd: '/ui', projectless: false, messages, isStreaming: !params.has('settled'), activeChangeScopeId: 'scope-a', model: null, thinkingLevel: 'off', eventSequence: 1 });
if (caseName === 'compaction') window.store.dispatch({type:'compaction_start',sessionPath:'/ui/rhythm',eventSequence:2,reason:'manual'});
flushSync(() => createRoot(document.getElementById('root')).render(
  React.createElement(I18nProvider, null, React.createElement(ImagePreviewProvider, null,
    React.createElement('div', { id: 'fixture', style: { height: 900, display: 'flex', flexDirection: 'column' } },
      React.createElement(ChatView, { store: window.store, onDismissError: () => {}, onResend: () => {}, onEditMessage: () => {}, onFork: () => {}, onReview: () => {} }))))
));

/** Capture the commit frame and every following frame. Geometry uses the whole
 * real transcript, so a second height change cannot hide behind a stable trigger. */
window.sampleToggle = async (needle, innerIndex) => {
  let row = window.findRow(needle);
  if (innerIndex !== undefined) {
    row = row.closest('[data-row]').querySelector('[data-transcript-tool-rows]').children[innerIndex];
  }
  const trigger = row.firstElementChild;
  const group = document.querySelector('[data-assistant-group]');
  const geometry = () => {
    const rect = (el) => { const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(n => Math.round(n * 100) / 100); };
    return {
      trigger: rect(trigger),
      group: rect(group),
      bodies: [...group.querySelectorAll('[data-agent-body][aria-hidden="false"]')]
        .filter(el => !el.parentElement.closest('[aria-hidden="true"]'))
        .map(el => ({ box: rect(el), padding: getComputedStyle(el).paddingTop, sizing: getComputedStyle(el).boxSizing, opacity: getComputedStyle(el).opacity, transform: getComputedStyle(el).transform, clip: getComputedStyle(el).clipPath }))
    };
  };
  const before = geometry();
  flushSync(() => trigger.click());
  const frames = [geometry()];
  for (let i = 0; i < 18; i++) {
    await new Promise(requestAnimationFrame);
    frames.push(geometry());
  }
  return { before, open: trigger.getAttribute('aria-expanded'), frames };
};

/** The turn's row column: the waiting row's parent. */
const inkBox = (root) => {
  const rowBox = root.getBoundingClientRect()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const candidates = []
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (!node.nodeValue || !node.nodeValue.trim()) continue
    // Screen-reader-only copy is not part of what the eye spaces out.
    if (node.parentElement?.closest('.sr-only, [aria-hidden="true"]')) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const box = range.getBoundingClientRect()
    if (!box.height) continue
    // A collapsed disclosure still LAYS OUT its children (height 0, clipped), so
    // anything outside the row's own box is not ink the reader can see.
    if (box.bottom <= rowBox.top + 0.5 || box.top >= rowBox.bottom - 0.5) continue
    candidates.push({ box, size: parseFloat(getComputedStyle(node.parentElement).fontSize) })
  }
  if (!candidates.length) return null
  // The row's LEADING text is what the reader spaces out; the smaller meta and
  // mono runs beside it only smear the union box.
  const largest = Math.max(...candidates.map((entry) => entry.size))
  const primary = candidates.filter((entry) => entry.size >= largest - 0.01)
  const top = Math.min(...primary.map((entry) => entry.box.top))
  const bottom = Math.max(...primary.map((entry) => entry.box.bottom))
  return { top, bottom, center: (top + bottom) / 2 }
};
window.rows = () => {
  const column = document.querySelector('#fixture [data-assistant-group] > [data-transcript-rows]');
  if (!column) return null;
  const style = getComputedStyle(column);
  return {
    gap: style.rowGap,
    columnTop: Math.round(column.getBoundingClientRect().top),
    text: column.innerText,
    items: [...column.children].map((row) => {
      const box = row.getBoundingClientRect();
      const ink = inkBox(row);
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        height: Math.round(box.height),
        inkCenter: ink ? Math.round(ink.center * 10) / 10 : null,
        inkTop: ink ? Math.round(ink.top * 10) / 10 : null,
        inkBottom: ink ? Math.round(ink.bottom * 10) / 10 : null,
        boxCenter: Math.round((box.top + box.height / 2) * 10) / 10,
        process: row.getAttribute('data-row') === 'process',
        roomyBefore: row.getAttribute('data-transcript-gap-before') === 'roomy',
        text: row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 46)
      };
    })
  };
};
/** Measure the visible type centre against the leading glyph's canvas, and
 * verify that truncation retains the complete CJK/descender ink bounds. */
window.labelAlignment = () => {
  const ctx = document.createElement('canvas').getContext('2d');
  const marker = () => { const span = document.createElement('span'); span.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'; return span; };
  return [...document.querySelectorAll('#fixture [data-agent-trigger], #fixture [data-spinner-verb]')]
    .filter(row => !row.closest('[aria-hidden="true"]'))
    .flatMap(row => {
      const labels = [...row.querySelectorAll('.transcript-label')];
      const label = labels.sort((a,b) => parseFloat(getComputedStyle(b).fontSize)-parseFloat(getComputedStyle(a).fontSize))[0];
      const icon = row.hasAttribute('data-spinner-verb') ? row.querySelector('[role="status"]') : row.querySelector('svg');
      if (!label || !icon) return [];
      const probe = marker(); label.append(probe);
      const style = getComputedStyle(label), baseline = probe.getBoundingClientRect().top;
      ctx.font = [style.fontStyle,style.fontWeight,style.fontSize,style.fontFamily].join(' ');
      const capital = ctx.measureText('H'), ink = ctx.measureText(label.textContent);
      const box = label.getBoundingClientRect(), glyph = icon.getBoundingClientRect();
      const center = baseline+(capital.actualBoundingBoxDescent-capital.actualBoundingBoxAscent)/2;
      const sample = {text:label.textContent,offset:glyph.top+glyph.height/2-center,
        clipped:baseline-ink.actualBoundingBoxAscent < box.top-0.1 || baseline+ink.actualBoundingBoxDescent > box.bottom+0.1,
        baselineOffsets:[...label.parentElement.children].filter(el => el !== label && el.classList.contains('transcript-label')).map(el => {
          const probe = marker(); el.append(probe); const delta = probe.getBoundingClientRect().top-baseline; probe.remove(); return delta;
        })};
      probe.remove(); return [sample];
    });
};
/** Compare the two boundaries around an expanded card. */
window.openBodyFrame = (needle) => {
  const row = window.findRow(needle);
  if (!row) return null;
  const button = row.firstElementChild;
  const body = row.querySelector('[data-tool-body], [data-diff-body]');
  if (!button || !body) return null;
  // A tool body wraps its card; a diff body IS the card.
  const card = body.hasAttribute('data-diff-body') ? body : (body.firstElementChild || body);
  const wrapper = row.closest('[data-row]') || row;
  const next = wrapper.nextElementSibling;
  const box = (el) => {
    const b = el.getBoundingClientRect();
    return { top: Math.round(b.top * 10) / 10, bottom: Math.round(b.bottom * 10) / 10 };
  };
  return {
    insetTop: Math.round((box(card).top - box(button).bottom) * 10) / 10,
    insetBottom: next ? Math.round((box(next).top - box(card).bottom) * 10) / 10 : null,
    paddingTop: getComputedStyle(body).paddingTop,
    paddingBottom: getComputedStyle(body).paddingBottom,
    text: (next ? next.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 20)
  };
};
/**
 * Open the index-th row INSIDE a group body (see ToolGroupView). The group's
 * rows are its own ToolCallViews, so they are not [data-row] wrappers and
 * findRow cannot pick between them by name (the group summary lists every
 * tool name).
 */
window.openInnerRow = (groupNeedle, index) => {
  const group = window.findRow(groupNeedle);
  const wrapper = group ? group.closest('[data-row]') : null;
  const body = wrapper ? wrapper.querySelector('[data-transcript-tool-rows]') : null;
  const row = body ? [...body.children][index] : null;
  // The group body's children ARE the ToolCallView roots, so the row itself is
  // the data-state trigger — querySelector only searches descendants.
  const trigger = row && row.hasAttribute && row.hasAttribute('data-state') ? row : null;
  if (!trigger || !trigger.firstElementChild) return false;
  trigger.firstElementChild.click();
  return true;
};
/**
 * An OPEN row inside a group body: the inset between its trigger and the card,
 * against the inset between the card and the NEXT TOP-LEVEL row — the group's
 * own bottom boundary, which must use the same gap as its internal boundaries.
 */
window.innerBodyFrame = (groupNeedle, index) => {
  const group = window.findRow(groupNeedle);
  const wrapper = group ? group.closest('[data-row]') : null;
  const body = wrapper ? wrapper.querySelector('[data-transcript-tool-rows]') : null;
  const row = body ? [...body.children][index] : null;
  const trigger = row && row.hasAttribute && row.hasAttribute('data-state') ? row : null;
  const button = trigger ? trigger.firstElementChild : null;
  const toolBody = row ? row.querySelector('[data-tool-body]') : null;
  const card = toolBody ? (toolBody.firstElementChild || toolBody) : null;
  const next = wrapper ? wrapper.nextElementSibling : null;
  if (!button || !card) return null;
  const box = (el) => {
    const b = el.getBoundingClientRect();
    return { top: Math.round(b.top * 10) / 10, bottom: Math.round(b.bottom * 10) / 10 };
  };
  return {
    insetTop: Math.round((box(card).top - box(button).bottom) * 10) / 10,
    insetBottom: next ? Math.round((box(next).top - box(card).bottom) * 10) / 10 : null,
    nextText: next ? next.innerText.replace(/\\s+/g, ' ').trim().slice(0, 24) : null
  };
};
/**
 * The rows INSIDE an expanded tool group's body (see ToolGroupView): the body
 * is the disclosure SIBLING of the group's trigger, so this walks up to the row
 * wrapper first. Used to measure Compact consecutive tool calls inside the body.
 */
window.groupRows = (needle) => {
  const row = window.findRow(needle);
  const wrapper = row ? row.closest('[data-row]') : null;
  const body = wrapper ? wrapper.querySelector('[data-transcript-tool-rows]') : null;
  if (!body) return null;
  const style = getComputedStyle(body);
  const items = [...body.children].map((child) => {
    const box = child.getBoundingClientRect();
    return {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      height: Math.round(box.height),
      text: child.innerText.replace(/\s+/g, ' ').trim().slice(0, 40)
    };
  });
  return {
    gap: style.rowGap,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    // The header → first row distance a reader sees: the group trigger's box
    // bottom to the first body row's top (the body's own top inset).
    headerGap: items.length
      ? Math.round((items[0].top - row.getBoundingClientRect().bottom) * 10) / 10
      : null,
    items
  };
};
/**
 * A row that opens a growing body (a reasoning row, a folded tool group): the
 * geometry of its trigger INSIDE its own row. The reader's report was that
 * opening the reasoning moved the row up a little — which is exactly the
 * trigger's offset inside the row shrinking, not the row moving in the page.
 */
window.triggerGeometry = (needle) => {
  const root = document.querySelector('#fixture');
  const row = [...root.querySelectorAll('[data-content][data-state]')].find(
    (el) => new RegExp(needle).test(el.textContent) && el.getBoundingClientRect().width > 0
  );
  if (!row) return null;
  const trigger = row.firstElementChild;
  const rowBox = row.getBoundingClientRect();
  const triggerBox = trigger.getBoundingClientRect();
  return {
    state: row.getAttribute('data-state'),
    rowHeight: Math.round(rowBox.height),
    triggerHeight: Math.round(triggerBox.height),
    offset: Math.round(triggerBox.top - rowBox.top),
    triggerInkTop: inkBox(trigger)?.top ?? null,
  };
};
window.toggleRow = (needle) => {
  const root = document.querySelector('#fixture');
  const row = [...root.querySelectorAll('[data-content][data-state]')].find(
    (el) => new RegExp(needle).test(el.textContent) && el.getBoundingClientRect().width > 0
  );
  row.firstElementChild.click();
};
/**
 * The left edge of a subtree's own ink — its text runs plus any image/button
 * boxes. This is the x a reader compares when they report "the expanded content
 * is not indented": the row trigger's leading text versus its body's.
 */
window.leadingInk = (node) => {
  let left = null;
  const keep = (value) => { if (left === null || value < left) left = value; };
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode;
    if (!text.nodeValue || !text.nodeValue.trim()) continue;
    if (text.parentElement && text.parentElement.closest('.sr-only')) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    const box = range.getBoundingClientRect();
    if (box.width) keep(box.left);
  }
  for (const el of node.querySelectorAll('img, button')) {
    const box = el.getBoundingClientRect();
    if (box.width) keep(box.left);
  }
  return left === null ? null : Math.round(left * 10) / 10;
};
/**
 * The row whose own TRIGGER text matches: body text is ignored, so a needle can
 * never match a row through content it merely happens to contain.
 */
window.findRow = (needle) => {
  const root = document.querySelector('#fixture');
  return [...root.querySelectorAll('[data-state]')].find(
    (el) => el.getBoundingClientRect().width > 0 && el.firstElementChild &&
      new RegExp(needle).test(el.firstElementChild.textContent)
  );
};
window.openRow = (needle) => {
  const row = window.findRow(needle);
  if (!row) return false;
  row.firstElementChild.click();
  return true;
};
/** A row's title indent against its expanded body's, and how the body is drawn. */
window.rowBody = (needle) => {
  const row = window.findRow(needle);
  if (!row || row.children.length < 2) return null;
  const trigger = row.firstElementChild;
  const body = row.children[1];
  const frame = body.querySelector('[data-tool-body]');
  return {
    state: row.getAttribute('data-state'),
    kind: frame ? frame.getAttribute('data-tool-body') : 'activity',
    box: frame ? Boolean(frame.querySelector('.rounded-xl')) : null,
    images: body.querySelectorAll('img').length,
    text: body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80),
    rowLeft: Math.round(row.getBoundingClientRect().left * 10) / 10,
    titleLeft: window.leadingInk(trigger),
    bodyLeft: window.leadingInk(body)
  };
};
/** A tool card's own frame: the padding above its output against the padding
 * below it, and whether a copy/status footer row sits inside it. */
window.bodyFrame = (needle) => {
  const row = window.findRow(needle);
  const body = row ? row.querySelector('[data-tool-body], [data-diff-body]') : null;
  // A tool body wraps its card; a diff body IS the card.
  const frame = body
    ? (body.hasAttribute('data-diff-body') ? body : body.querySelector('.rounded-xl'))
    : null;
  if (!frame) return null;
  // The padding lives ON the content div, so the INK below it is what shows the
  // card's top-to-bottom symmetry.
  // The pinned bash command is a separate header above the output viewport.
  // Measure the output's own padding rather than including that header.
  const viewport = frame.querySelector('[role="log"]') || frame.firstElementChild;
  const content = viewport ? viewport.firstElementChild : null;
  const ink = content && content.firstElementChild ? content.firstElementChild : content;
  const frameBox = viewport.getBoundingClientRect();
  const inkBox = ink ? ink.getBoundingClientRect() : frameBox;
  return {
    top: Math.round((inkBox.top - frameBox.top) * 10) / 10,
    bottom: Math.round((frameBox.bottom - inkBox.bottom) * 10) / 10,
    footer: frame.querySelectorAll('[aria-label="Copy result"], [aria-label="Copied"], [aria-label="Run again"], [aria-label="Copy diff"]').length,
    labels: [...frame.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'))
  };
};
/** The output card's fold: where the cap lands against the code lines it shows. */
window.outputFold = (needle) => {
  const row = window.findRow(needle);
  const viewport = row ? row.querySelector('[data-tool-body] [role=\"log\"]') : null;
  if (!viewport) return null;
  const lines = [...viewport.querySelectorAll('pre > code > span')];
  const edge = viewport.getBoundingClientRect().bottom;
  const boxes = lines.map((el) => el.getBoundingClientRect());
  const mask = getComputedStyle(viewport).maskImage;
  return {
    cap: Math.round(viewport.getBoundingClientRect().height),
    scroll: viewport.scrollHeight,
    lineCount: boxes.length,
    pitch: boxes.length > 1 ? Math.round(boxes[1].top - boxes[0].top) : null,
    cut: boxes.filter((b) => b.top < edge - 0.5 && b.bottom > edge + 0.5).length,
    visible: boxes.filter((b) => b.bottom <= edge + 0.5).length,
    fade: viewport.getAttribute('data-fade'),
    mask
  };
};
window.clickThumb = (needle, index) => {
  const row = window.findRow(needle);
  const body = row ? row.querySelector('[data-tool-body]') : null;
  const buttons = body ? [...body.querySelectorAll('button')] : [];
  if (!buttons[index]) return false;
  buttons[index].click();
  return true;
};
/** How the row's image actually landed: a capture-sized image must stay inside
 * the row (the thumbnail is a shrink-to-fit button around the image). */
window.imageFit = (needle) => {
  const row = window.findRow(needle);
  const body = row ? row.querySelector('[data-tool-body]') : null;
  const image = body ? body.querySelector('img') : null;
  if (!image) return null;
  const imageBox = image.getBoundingClientRect();
  return {
    width: Math.round(imageBox.width),
    height: Math.round(imageBox.height),
    ratio: Math.round((imageBox.width / imageBox.height) * 100) / 100,
    rowWidth: Math.round(row.getBoundingClientRect().width),
    overflow: Math.round(row.scrollWidth - row.clientWidth)
  };
};
window.imageDialog = () => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return { label: null, openFile: false, close: false };
  return {
    label: dialog.getAttribute('aria-label'),
    openFile: [...dialog.querySelectorAll('button')].some((b) => (b.textContent || '').indexOf('Open file') !== -1),
    close: Boolean(dialog.querySelector('[aria-label="Close preview"]'))
  };
};
window.previewSurfaces = () => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return null;
  const viewport = dialog.querySelector('[role="group"]');
  const root = viewport && viewport.parentElement;
  const bars = root ? [...root.children].filter((el) => el !== viewport) : [];
  const fill = (el) => (el ? getComputedStyle(el).backgroundColor : null);
  const image = viewport && viewport.querySelector('img');
  const corner = image ? getComputedStyle(image) : null;
  return {
    panel: fill(dialog),
    viewport: fill(viewport),
    bars: bars.map(fill),
    // The picture follows the interface style: window-step radius, app corner shape.
    image: corner
      ? { radius: corner.borderTopLeftRadius, shape: corner.cornerShape,
          step: getComputedStyle(document.documentElement).getPropertyValue('--app-radius-window').trim() }
      : null
  };
};
window.clickDialog = (what) => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return false;
  const button = what === 'open'
    ? [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').indexOf('Open file') !== -1)
    : dialog.querySelector('[aria-label="Close preview"]');
  if (!button) return false;
  button.click();
  return true;
};
window.fixtureReady = true;
</script></body></html>`

let child, ws, server
try {
  server = await createServer({
    configFile: false,
    root: join(repo, 'src/renderer'),
    logLevel: 'error',
    cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [
      react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }),
      tailwindcss(),
      {
        name: 'rhythm-fixture',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url?.split('?')[0] !== fixturePath) return next()
            try {
              res.setHeader('Content-Type', 'text/html')
              res.end(await server.transformIndexHtml(fixturePath, fixture))
            } catch (error) {
              next(error)
            }
          })
        }
      }
    ],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  const main = join(temporary, 'main.cjs')
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:1000,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(origin)});});
app.on('window-all-closed',()=>app.quit());`
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [main], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Electron debugger did not start: ' + output)), 15000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('Electron exited: ' + code))
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve('http://127.0.0.1:' + match[1])
      }
    })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page')
    if (!page) await pause(50)
  }
  assert.ok(page, 'Electron page created')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  const pending = new Map()
  const exceptions = []
  // Electron's own sandboxed-renderer bundle complains about missing preload
  // startup data in a window that has none; that is not our page.
  const ELECTRON_NOISE = /sandboxed_renderer\.bundle\.js|binding\.startupData/
  let sequence = 0
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params)
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map((a) => a.value ?? a.description).join(' ')
      if (!ELECTRON_NOISE.test(text)) exceptions.push({ console: text })
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, (m) => (m.error ? reject(m.error) : resolve(m.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const load = async (query) => {
    await send('Page.navigate', { url: origin + (query ?? '') })
    for (let i = 0; i < 200; i++) {
      if (await evaluate('!!window.fixtureReady && !!document.querySelector("#fixture [data-assistant-group]")')) return
      await pause(50)
    }
    throw new Error(
      'Fixture did not mount: ' +
        JSON.stringify({
          ready: await evaluate('!!window.fixtureReady'),
          body: await evaluate('document.body.innerText.slice(0, 200)'),
          exceptions: exceptions.slice(0, 2).map((entry) => entry.exception?.description ?? entry.console ?? String(entry))
        })
    )
  }
  const screenshot = async (name) => {
    if (!process.env.PI_TRANSCRIPT_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_TRANSCRIPT_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_TRANSCRIPT_SCREENSHOT_DIR, name + '.png'), Buffer.from(capture.data, 'base64'))
  }
  /**
   * The rhythm a reader actually sees: every row is the same box with its own
   * content centred, so two consecutive rows' text is the same distance apart
   * whichever pair you look at. A row whose box is taller than its content
   * would add its slack to that distance, which is the bug this pins.
   */
  const assertRhythm = (state, label) => {
    assert.ok(state.items.length >= 2, `${label}: the turn paints rows`)
    assert.equal(state.gap, '0px', `${label}: no flex gap doubles the boundary spacing`)
    state.items.forEach((row, index) => {
      assert.ok(row.height > 0, `${label}: row ${index} (${row.text}) paints a real row, not an empty slot`)
      assert.ok(
        row.height >= ROW_HEIGHT,
        `${label}: row ${index} (${row.text}) is at least the shared ${ROW_HEIGHT}px box, got ${row.height}px`
      )
      if (index === 0) return
      const gap = row.top - state.items[index - 1].bottom
      assert.equal(
        gap,
        ROW_GAP,
        `${label}: row ${index} sits ${ROW_GAP}px below the previous one, not ${gap}px (${state.items[index - 1].text} → ${row.text})`
      )
      const pitch = row.inkCenter - state.items[index - 1].inkCenter
      // ±2px: a row's leading text can sit a hair off its box centre when
      // smaller meta text shares its baseline (the group row's label), which is
      // below what the eye reads as different spacing — unlike the 4–8px a
      // taller box used to add.
      assert.ok(
        Math.abs(pitch - (ROW_HEIGHT + ROW_GAP)) <= 2,
        `${label}: the text of rows ${index - 1} and ${index} is ${ROW_HEIGHT + ROW_GAP}px apart, got ${pitch}px (${state.items[index - 1].text} → ${row.text})`
      )
    })
  }

  // A closed long process must not create a scrollable blank tail. Opening a
  // saved session follows its real reply, and expanding/collapsing the process
  // or changing the motion preference must preserve that live edge.
  const foldScroll = () => evaluate(`(() => {
    const log = document.querySelector('[role="log"]');
    const viewport = log.parentElement;
    const reply = [...log.querySelectorAll('[data-row="text"]')].at(-1);
    const box = reply.getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    return { height: log.offsetHeight, scrollHeight: log.scrollHeight,
      overflow: viewport.scrollHeight > viewport.clientHeight + 1,
      atEnd: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1,
      replyVisible: box.bottom > view.top && box.top < view.bottom,
      processHeight: log.querySelector('[data-turn-process]').offsetHeight };
  })()`);
  for (const compact of [0, 1]) {
    await load('?case=longFold&settled=1&instant=1&compact=' + compact);
    await pause(250);
    const closed = await foldScroll();
    assert.ok(closed.processHeight > 900, 'the folded process exceeds the viewport');
    assert.ok(closed.scrollHeight <= closed.height + 1,
      'closed tool statuses cannot extend the transcript scroll range: ' + JSON.stringify(closed));
    assert.equal(closed.overflow, false, 'the short reply has no phantom scroll range');
    assert.equal(closed.replyVisible, true, 'opening the session shows its reply');
    await evaluate(`window.openRow('Took')`);
    await pause(250);
    const expanded = await foldScroll();
    assert.equal(expanded.overflow, true, 'opening the process creates real scrollable content');
    assert.equal(expanded.atEnd && expanded.replyVisible, true, 'the expanded process follows the reply');
    await evaluate(`window.openRow('Took')`);
    await pause(250);
    const collapsed = await foldScroll();
    assert.equal(collapsed.overflow, false, 'collapsing removes the process scroll range');
    assert.equal(collapsed.replyVisible, true, 'collapsing keeps the reply visible');
    await evaluate(`window.setInstant(false)`);
    await pause(250);
    await evaluate(`window.setInstant(true)`);
    await pause(250);
    const toggled = await foldScroll();
    assert.equal(toggled.overflow, false, 'disabling animations cannot restore a hidden scroll range');
    assert.equal(toggled.replyVisible, true, 'motion changes keep the reply visible');
  }

  if (!process.env.PI_RHYTHM_INSTANT_ONLY) {
  // --- the reported turn: a round that opens with a bare space between tools
  await load()
  await pause(300)
  const invisible = await evaluate('window.rows()')
  assertRhythm(invisible, 'invisible separator')
  // `todo_write` is its own row (uncategorized), the four exploration calls are
  // one group: the invisible text blocks separate nothing, so the two grep/read
  // rounds merge into a single row.
  assert.equal(invisible.items.length, 3, `three rows: a tool, one merged group, the waiting row — got ${JSON.stringify(invisible.items.map((r) => r.text))}`)
  assert.match(invisible.items[1].text, /^Exploration 4 tools/, 'the first exploration round renders the merged group')
  assert.equal(
    (invisible.text.match(/Exploration/g) ?? []).length,
    1,
    'a whitespace-only text block never splits a visually continuous tool run'
  )
  assert.match(invisible.items[2].text, /./, 'the waiting row is the last row of the turn')
  await screenshot('invisible-separator')

  // --- a real prose block between two tool rounds keeps its own row, and the
  // rhythm is unchanged around it; two rows inside ONE round share it too
  await load('?case=visible')
  await pause(300)
  const visible = await evaluate('window.rows()')
  assertRhythm(visible, 'visible prose')
  // Round 1 paints two different-category rows (edit + bash, one block), then
  // the prose row, then a terminal row, then the merged three-call read group,
  // then the waiting row.
  assert.equal(visible.items.length, 6, `six rows — got ${JSON.stringify(visible.items.map((r) => r.text))}`)
  assert.match(visible.items[2].text, /The fix is in/, 'prose keeps its own row')
  assert.match(visible.items[4].text, /^Exploration 3 tools/, 'the three adjacent read calls fold into one group row')
  await screenshot('visible-prose')

  // --- a tool card has no copy/status footer row: the header already states the
  //     status with its glyph, and the bar made the card's bottom padding larger
  //     than its top (the reported "Copy + Completed" row)
  assert.equal(await evaluate(`window.openRow('bash ·')`), true, 'the bash row opens')
  await pause(400)
  const card = await evaluate(`window.bodyFrame('bash ·')`)
  assert.equal(card.footer, 0, `no copy/retry footer inside the card: ${JSON.stringify(card.labels)}`)
  assert.ok(card.top > 0, `the card keeps its own top padding: ${JSON.stringify(card)}`)
  assert.ok(
    Math.abs(card.top - card.bottom) <= 0.5,
    `the card's padding is the same top and bottom: ${card.top} / ${card.bottom}`
  )
  await screenshot('tool-card-padding')

  // --- the same turn with reasoning blocks shown: a reasoning row is a row
  // like any other, and it is a VISIBLE separator, so the two tool runs stay
  // two GROUP rows — still on the one rhythm
  await load('?case=reasoning')
  await pause(300)
  const reasoning = await evaluate('window.rows()')
  assertRhythm(reasoning, 'reasoning rows')
  assert.equal(
    reasoning.items.length,
    7,
    `reasoning, tool and waiting rows alternate — got ${JSON.stringify(reasoning.items.map((r) => r.text))}`
  )
  assert.equal(
    (reasoning.text.match(/Exploration/g) ?? []).length,
    2,
    'a VISIBLE reasoning row really does separate two tool runs'
  )
  await screenshot('reasoning-rows')

  // --- the reported trio: a read row, a bash row and a 3-call GROUP row
  await load('?case=mixed')
  await pause(300)
  const mixed = await evaluate('window.rows()')
  assertRhythm(mixed, 'read / bash / group')
  assert.equal(
    mixed.items.length,
    4,
    `a read row, a bash row, a group row and the waiting row — got ${JSON.stringify(mixed.items.map((r) => r.text))}`
  )
  assert.match(mixed.items[0].text, /^read/, 'the first row is the read call')
  assert.match(mixed.items[1].text, /^bash/, 'the second row is the bash call')
  assert.match(mixed.items[2].text, /^Exploration 3 tools/, 'the third row is the folded group')
  assert.equal(mixed.items[2].height, mixed.items[0].height, 'a GROUP row is the same box as a tool row')
  // A group row opens the same growing body a reasoning row does, so it carries
  // the trigger-owns-the-row invariant too.
  const closedGroup = await evaluate(`window.triggerGeometry('tools')`)
  assert.equal(closedGroup.triggerHeight, ROW_HEIGHT, `a growing row's trigger takes the row's own ${ROW_HEIGHT}px box`)
  assert.equal(closedGroup.offset, 0, 'a growing row\'s trigger has no slack to be re-centred in')
  await screenshot('read-bash-group')

  // --- opening a row that GROWS its own body must move nothing. The trigger
  //     used to sit 4px down (the 36px row's slack around a 28px trigger) and
  //     snapped to the top the moment the body exceeded that slack — the row
  //     visibly jumped up on every open, in either direction. Giving the trigger
  //     the row's box removes the slack, so the expansion has nothing to move.
  await load('?case=reasoning')
  await pause(300)
  const beforeOpen = await evaluate(`window.triggerGeometry('Reasoning')`)
  assert.equal(beforeOpen.state, 'closed', 'the reasoning row starts collapsed')
  assert.equal(beforeOpen.triggerHeight, ROW_HEIGHT, `the collapsed trigger is the row's own ${ROW_HEIGHT}px box: ${JSON.stringify(beforeOpen)}`)
  assert.equal(beforeOpen.offset, 0, `the collapsed trigger is flush with the row's top: ${JSON.stringify(beforeOpen)}`)
  await evaluate(`window.toggleRow('Reasoning')`)
  await pause(500)
  const afterOpen = await evaluate(`window.triggerGeometry('Reasoning')`)
  assert.equal(afterOpen.state, 'open', 'the reasoning row really did open')
  assert.ok(afterOpen.rowHeight > beforeOpen.rowHeight, `the body grew: ${JSON.stringify(afterOpen)}`)
  assert.equal(afterOpen.offset, 0, `opening moves nothing: the trigger is still flush with the row's top (${JSON.stringify(afterOpen)})`)
  assert.ok(
    Math.abs(afterOpen.triggerInkTop - beforeOpen.triggerInkTop) <= 0.5,
    `the trigger's own text keeps its exact position across the open: ${beforeOpen.triggerInkTop} → ${afterOpen.triggerInkTop}`
  )
  await screenshot('reasoning-open')

  // --- a file tool's row label IS one of the app's file links: it opens the
  //     file (window.pi.openPath stands in for the files pane here) in the
  //     prose link's style, and never toggles the disclosure the label sits
  //     in — checked on a plain row nested in a group (read) and on a FileDiff
  //     header (edit).
  await load('?case=groupOpen')
  await pause(250)
  await evaluate(`window.openRow('Exploration')`)
  await pause(300)
  const readLink = await evaluate(`(() => {
    const row = window.findRow('read · tool-runs');
    const group = window.findRow('Exploration');
    const link = row.firstElementChild.querySelector('[data-file-link]');
    if (!link) return null;
    const style = getComputedStyle(link);
    const before = [row.firstElementChild.getAttribute('aria-expanded'), group.firstElementChild.getAttribute('aria-expanded')];
    link.click();
    return {
      text: link.textContent,
      label: row.firstElementChild.textContent,
      underline: style.textDecorationLine.includes('underline'),
      pointer: style.cursor === 'pointer',
      opened: window.__opened,
      before,
      after: [row.firstElementChild.getAttribute('aria-expanded'), group.firstElementChild.getAttribute('aria-expanded')]
    };
  })()`)
  assert.ok(readLink, 'a read row carries a file link in its title')
  assert.equal(readLink.text, 'tool-runs.ts', 'the link is the file basename')
  assert.ok(
    readLink.label.startsWith('read · tool-runs.ts — src/renderer/src/lib'),
    `the label text is the one it always was: ${readLink.label}`
  )
  assert.equal(readLink.underline, true, 'the link is underlined like a prose file link')
  assert.equal(readLink.pointer, true, 'the link advertises its pointer cursor')
  assert.equal(readLink.opened, '/ui/src/renderer/src/lib/tool-runs.ts', 'clicking opens the resolved file')
  assert.deepEqual(readLink.after, readLink.before, 'the click never reaches the disclosures')
  assert.equal(readLink.after[0], 'false', 'the read row stays collapsed')
  assert.equal(readLink.after[1], 'true', 'the surrounding group stays open')
  const editLink = await evaluate(`(() => {
    const row = window.findRow('edit ·');
    const link = row.firstElementChild.querySelector('[data-file-link]');
    if (!link) return null;
    const before = row.firstElementChild.getAttribute('aria-expanded');
    link.click();
    return { text: link.textContent, opened: window.__opened, before, after: row.firstElementChild.getAttribute('aria-expanded') };
  })()`)
  assert.ok(editLink, 'a FileDiff header carries the same file link')
  assert.equal(editLink.text, 'styles.css', 'the diff header links the file basename')
  assert.equal(editLink.opened, '/ui/src/renderer/src/styles.css', 'the diff link opens the edited file')
  assert.equal(editLink.after, editLink.before, 'the diff row does not toggle either')
  await screenshot('tool-file-links')

  // --- a tool whose output is an image: the image renders ALONE, without the
  //     framed output box, at the row's own text indent — and clicking it opens
  //     the same preview overlay every other image in the app uses
  await load('?case=images')
  await pause(300)
  const imageRowTurn = await evaluate('window.rows()')
  assertRhythm(imageRowTurn, 'image output')
  assert.equal(
    imageRowTurn.items.length,
    7,
    `read image · screenshot · reasoning · grep · prose · read text · waiting — got ${JSON.stringify(imageRowTurn.items.map((r) => r.text))}`
  )
  await screenshot('image-output')

  const collapsedImage = await evaluate(`window.rowBody('shot.png')`)
  assert.equal(collapsedImage.state, 'success', 'the read row settled')
  assert.equal(collapsedImage.bodyLeft, null, 'a collapsed row mounts no body to indent')

  await evaluate(`window.openRow('shot.png')`)
  await pause(500)
  const imageRow = await evaluate(`window.rowBody('shot.png')`)
  assert.equal(imageRow.kind, 'bare', 'an image result renders WITHOUT the framed output box')
  assert.equal(imageRow.box, false, 'no output box is painted inside the row')
  assert.equal(imageRow.images, 1, 'the image the tool returned is what the row shows')
  assert.equal(imageRow.text, '', 'the read tool\'s own "Read image file …" bookkeeping text is not painted')
  // The row's own text starts at 16px icon + 8px gap; the body must land there
  // too, which is what "the expanded content keeps an indent" means.
  assert.ok(
    Math.abs(imageRow.titleLeft - imageRow.rowLeft - 24) <= 0.5,
    `the row title starts 24px into the row: ${imageRow.titleLeft - imageRow.rowLeft}`
  )
  assert.ok(
    Math.abs(imageRow.bodyLeft - imageRow.rowLeft - 24) <= 0.5,
    `the image starts 24px into the row, where the title does: ${imageRow.bodyLeft - imageRow.rowLeft}`
  )
  // A capture-sized image stays inside its row — thumbnails are shrink-to-fit
  // buttons, the shape that can let a wide image push the column out.
  const fit = await evaluate(`window.imageFit('shot.png')`)
  assert.ok(fit.width <= fit.rowWidth, `the image fits its row: ${fit.width} ≤ ${fit.rowWidth}`)
  assert.ok(fit.height <= 256.5, `the image honours the 256px cap: ${fit.height}`)
  assert.ok(Math.abs(fit.ratio - 1600 / 900) < 0.02, `the image keeps its aspect ratio: ${fit.ratio}`)
  assert.ok(fit.overflow <= 0, `the row does not overflow horizontally: ${fit.overflow}`)

  // A hovered thumbnail must not lift: the zoom cursor, the focus ring and the
  // preview are the affordance. Measured on the real control, with the pointer
  // really over it, so "no shadow" cannot pass by never hovering anything.
  const thumb = await evaluate(`(() => {
    const image = window.findRow('shot.png').querySelector('[data-tool-body] img');
    const box = image.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: thumb.x, y: thumb.y })
  await pause(250)
  const thumbHover = await evaluate(`(() => {
    const trigger = window.findRow('shot.png').querySelector('[data-tool-body] button');
    return { hover: trigger.matches(':hover'), shadow: getComputedStyle(trigger).boxShadow };
  })()`)
  assert.equal(thumbHover.hover, true, 'the pointer really is over the thumbnail')
  assert.equal(thumbHover.shadow, 'none', `a hovered thumbnail carries no shadow: ${thumbHover.shadow}`)
  await screenshot('image-row-open')

  // The same tool with a TEXT result keeps the framed box, its output inside the
  // box's own 12px padding — so the change is about images, not about read rows.
  await evaluate(`window.openRow('app.ts')`)
  await pause(400)
  const textRow = await evaluate(`window.rowBody('app.ts')`)
  assert.equal(textRow.kind, 'framed', 'a text result keeps the framed output box')
  assert.equal(textRow.box, true, 'the box is really painted')
  assert.match(textRow.text, /ok/, 'a text result still paints its output')
  assert.ok(
    Math.abs(textRow.bodyLeft - textRow.rowLeft - 36) <= 0.5,
    `a framed body's text sits 12px inside its box (24 + 12): ${textRow.bodyLeft - textRow.rowLeft}`
  )

  // A capture's own notes are bookkeeping too: the row shows the screenshot alone.
  await evaluate(`window.openRow('browser_screenshot')`)
  await pause(400)
  const shotRow = await evaluate(`window.rowBody('browser_screenshot')`)
  assert.equal(shotRow.kind, 'bare', 'a screenshot renders without the framed box')
  assert.equal(shotRow.images, 1, 'the capture is painted')
  assert.equal(shotRow.text, '', 'the screenshot note text is not painted beside the capture')
  const shotFit = await evaluate(`window.imageFit('browser_screenshot')`)
  assert.ok(shotFit.width <= shotFit.rowWidth, `the capture fits its row: ${shotFit.width} ≤ ${shotFit.rowWidth}`)
  assert.ok(shotFit.height <= 256.5, `the capture honours the same 256px cap: ${shotFit.height}`)
  assert.ok(Math.abs(shotFit.ratio - 1600 / 900) < 0.02, `the capture is neither cropped nor letterboxed: ${shotFit.ratio}`)
  assert.ok(shotFit.overflow <= 0, `the capture's row does not overflow: ${shotFit.overflow}`)

  // --- the tool's image IS the app-wide preview: one click opens the overlay,
  //     which offers the file the tool read, and it closes again
  assert.equal(await evaluate(`window.clickThumb('shot.png', 0)`), true, 'the thumbnail is a real control')
  await pause(500)
  const dialog = await evaluate('window.imageDialog()')
  assert.equal(dialog.label, 'Image 1', `the thumbnail opens the app-wide image preview: ${JSON.stringify(dialog)}`)
  assert.equal(dialog.openFile, true, 'the preview offers the file the tool read')
  assert.equal(dialog.close, true, 'the preview has its close control')

  // The preview is an OPEN frame: neither its panel nor the image viewport
  // paints a surface, so the blank area around the image is the dimmed page
  // behind it. Only the caption and control bars carry the app surface.
  const surfaces = await evaluate('window.previewSurfaces()')
  assert.equal(surfaces.panel, 'rgba(0, 0, 0, 0)', `the preview panel paints no surface: ${surfaces.panel}`)
  assert.equal(surfaces.viewport, 'rgba(0, 0, 0, 0)', `the image viewport paints no surface: ${surfaces.viewport}`)
  assert.equal(surfaces.bars.length, 2, `the caption and control bars are the preview's only fills: ${surfaces.bars.length}`)
  for (const bar of surfaces.bars) {
    assert.notEqual(bar, 'rgba(0, 0, 0, 0)', `a preview bar carries the app surface: ${bar}`)
  }
  assert.equal(surfaces.bars[0], surfaces.bars[1], `both bars carry the same surface: ${surfaces.bars.join(' / ')}`)
  assert.ok(surfaces.image, 'the preview really holds an image')
  assert.equal(surfaces.image.radius, surfaces.image.step, `the picture takes the app's window-step radius: ${surfaces.image.radius} vs ${surfaces.image.step}`)
  assert.equal(surfaces.image.shape, 'superellipse(2)', `the picture carries the app's corner shape: ${surfaces.image.shape}`)
  // The squircle preset must round the picture for real, and never less than the
  // macOS window corner (26pt on Tahoe, 20 on the next release, 10 before);
  // the screenshot is the evidence that the painted corner is a superellipse.
  const cornerAttribute = await evaluate(`document.documentElement.dataset.corners || ''`)
  await evaluate(`document.documentElement.dataset.corners = 'squircle'`)
  await pause(400)
  const squircleSurfaces = await evaluate('window.previewSurfaces()')
  assert.equal(squircleSurfaces.image.step, '28px', 'the squircle preset moves the window step')
  assert.equal(squircleSurfaces.image.radius, '28px', `the squircle style rounds the picture: ${squircleSurfaces.image.radius}`)
  assert.ok(parseFloat(squircleSurfaces.image.radius) >= 26, `the picture is never less round than the macOS window corner: ${squircleSurfaces.image.radius}`)
  assert.equal(squircleSurfaces.image.shape, 'superellipse(2)', 'the rounded corner stays a superellipse')
  await screenshot('image-preview-squircle')
  await evaluate(cornerAttribute ? `document.documentElement.dataset.corners = ${JSON.stringify(cornerAttribute)}` : `delete document.documentElement.dataset.corners`)
  await pause(400)
  await screenshot('image-preview')
  assert.equal(await evaluate(`window.clickDialog('open')`), true, 'the open-file action is clickable')
  await pause(200)
  assert.equal(await evaluate('window.__opened'), '/ui/docs/shot.png', 'the preview opens the file the tool read')
  assert.equal(await evaluate(`window.clickDialog('close')`), true, 'the preview closes')
  await pause(700)
  assert.equal(await evaluate(`Boolean(document.querySelector('[role="dialog"]'))`), false, 'the overlay is gone again')
  await screenshot('image-preview-closed')

  // --- the reasoning body starts where the row's own "Reasoning" label does:
  //     the indent a tool body has, which a reader reported missing
  await evaluate(`window.openRow('Reasoning')`)
  await pause(400)
  const reasoningBody = await evaluate(`window.rowBody('Reasoning')`)
  assert.equal(reasoningBody.kind, 'activity', 'the reasoning body is not a tool body')
  assert.match(reasoningBody.text, /checked the capture/, 'the reasoning text is what the body paints')
  assert.ok(
    Math.abs(reasoningBody.titleLeft - reasoningBody.rowLeft - 24) <= 0.5,
    `the Reasoning label starts 24px into the row: ${reasoningBody.titleLeft - reasoningBody.rowLeft}`
  )
  assert.ok(
    Math.abs(reasoningBody.bodyLeft - reasoningBody.rowLeft - 24) <= 0.5,
    `the reasoning body starts where its own label starts: ${reasoningBody.bodyLeft - reasoningBody.rowLeft}`
  )
  await screenshot('reasoning-indent')

  // --- an image that did NOT come back cleanly: the text beside it is the
  //     tool's diagnosis, so it stays; an undecodable image does not linger
  await load('?case=failure')
  await pause(300)
  const failureRows = await evaluate('window.rows()')
  assertRhythm(failureRows, 'failed image results')
  assert.equal(
    failureRows.items.length,
    6,
    `read(error) · prose · read(broken) · prose · grep · waiting — got ${JSON.stringify(failureRows.items.map((r) => r.text))}`
  )

  await evaluate(`window.openRow('err.png')`)
  await pause(500)
  const errored = await evaluate(`window.rowBody('err.png')`)
  assert.equal(errored.kind, 'framed', 'a FAILED result keeps the framed output box')
  assert.match(errored.text, /Read image file/, "a failed result's own text is painted beside its image")
  assert.equal(errored.images, 1, 'the image the failed result carried is still shown')
  assert.doesNotMatch(errored.text, /\[image\]/, "the text is the tool's own words, not a placeholder for the picture the row already paints")

  await evaluate(`window.openRow('broken.png')`)
  await pause(800)
  const undecodable = await evaluate(`window.rowBody('broken.png')`)
  assert.equal(undecodable.kind, 'framed', 'an undecodable image falls back to the framed text')
  assert.match(undecodable.text, /could not decode/, 'the tool\'s explanation is painted')
  assert.equal(undecodable.images, 0, 'the image that cannot be decoded is not left behind as a broken icon')
  await screenshot('image-failure')

  // --- a capped output card folds on a LINE boundary — the 12px padding lives
  //     inside the scrollport, so the cap is `padding + n × line` — and the fade
  //     sits on the edge that actually hides content (it was swapped, which is
  //     why the fold looked like a hard chop of a half line)
  await load('?case=long')
  await pause(300)
  assert.equal(await evaluate(`window.openRow('bash ·')`), true, 'the long-output row opens')
  await pause(400)
  const fold = await evaluate(`window.outputFold('bash ·')`)
  assert.equal(fold.lineCount, 30, `the fixture paints 30 output lines: ${JSON.stringify(fold)}`)
  assert.equal(fold.pitch, 20, `AgentCode's line grid is the 20px one: ${fold.pitch}`)
  assert.equal(fold.cut, 0, `no line is sliced by the fold: ${JSON.stringify(fold)}`)
  assert.equal(fold.visible, 11, `eleven whole lines fit the card: ${JSON.stringify(fold)}`)
  assert.equal((fold.cap - 12) % fold.pitch, 0, `the cap is padding + n × line: ${fold.cap}`)
  assert.equal(fold.fade, 'bottom', 'content below the fold: the hidden edge is the bottom one')
  // The mask's own colour stops, split on top-level commas only: the last one is
  // transparent exactly when the bottom edge is the one being hidden.
  const stops = fold.mask
    .slice(fold.mask.indexOf('(') + 1, fold.mask.lastIndexOf(')'))
    .split(/,(?![^(]*\))/)
  assert.ok(
    stops[stops.length - 1].includes('rgba(0, 0, 0, 0)'),
    `the bottom edge is the one that fades: ${fold.mask}`
  )
  assert.ok(!stops[0].includes('rgba(0, 0, 0, 0)'), `the top edge is not faded at the top of the scroll: ${fold.mask}`)
  await screenshot('long-output-fold')
  // Shared gaps at every depth, with explicit roomy boundaries for prose,
  // the turn fold and the persistent waiting row.
  for (const compact of [false, true]) {
    const gap = compact ? 4 : ROW_GAP
    const query = '&compact=' + Number(compact)
    for (const name of ['compact', 'compaction', 'notice', 'groupOpen', 'long']) {
      await load('?case=' + name + query)
      await pause(250)
      const state = await evaluate('window.rows()')
      for (let index = 1; index < state.items.length; index++) {
        const prev = state.items[index - 1], row = state.items[index]
        const expected = prev.process && row.process && !row.roomyBefore ? gap : ROW_GAP
        assert.equal(row.top - prev.bottom, expected, `${name}/${compact}: ${prev.text} → ${row.text}`)
      }
      if (name === 'compaction') {
        assert.match(state.items.at(-2).text, /^Summarize context/, 'the last process row is compaction')
        assert.equal(state.items.at(-2).height, ROW_HEIGHT, 'compaction is one ordinary tool row tall')
        assert.equal(await evaluate(`document.querySelectorAll('#fixture [data-spinner-loader]').length`), 1, 'compaction has one turn spinner after it')
        await screenshot('compaction-before-spinner-' + Number(compact))
      }
    }
    await evaluate(`window.openRow('bash ·')`)
    await pause(300)
    let frame = await evaluate(`window.openBodyFrame('bash ·')`)
    assert.equal(frame.insetTop, gap, 'tool header → card')
    assert.equal(frame.insetBottom, gap, 'card → next row')
    assert.equal(frame.paddingBottom, '0px', 'a body has no duplicate bottom spacing')

    await load('?case=groupOpen' + query)
    await pause(250)
    await evaluate(`window.openRow('Exploration')`)
    await pause(300)
    const group = await evaluate(`window.groupRows('Exploration')`)
    assert.equal(group.headerGap, gap, 'group header → first child')
    assert.equal(group.gap, '0px', 'nested rows also use one margin per boundary')
    assert.equal(group.paddingBottom, '0px', 'group has no trailing inset')
    for (let index = 1; index < group.items.length; index++) {
      assert.equal(group.items[index].top - group.items[index - 1].bottom, gap, 'group child → child')
    }
    await evaluate(`window.openInnerRow('Exploration', 1)`)
    await pause(300)
    frame = await evaluate(`window.innerBodyFrame('Exploration', 1)`)
    assert.equal(frame.insetTop, gap, 'last child header → card')
    assert.equal(frame.insetBottom, gap, 'last child card → next top-level row')
    await evaluate(`window.openRow('edit')`)
    await pause(300)
    frame = await evaluate(`window.openBodyFrame('edit')`)
    assert.equal(frame.insetTop, gap, 'diff header → card')
    assert.equal(frame.insetBottom, gap, 'diff card → next group')
    assert.equal((await evaluate(`window.bodyFrame('edit')`)).footer, 0, 'diff has no footer bar')
    await screenshot(compact ? 'compact-nested-open' : 'roomy-nested-open')
  }

  }
  const assertInstantToggle = async (needle, innerIndex) => {
    const sample = await evaluate(`window.sampleToggle(${JSON.stringify(needle)}, ${JSON.stringify(innerIndex)})`)
    assert.equal(sample.frames[0].trigger[1], sample.before.trigger[1], `${needle}: trigger stays put in the commit frame`)
    assert.notEqual(sample.frames[0].group[3], sample.before.group[3], `${needle}: disclosure really changes height`)
    for (const frame of sample.frames) {
      assert.deepEqual(frame, sample.frames[0], `${needle}: no delayed movement after the commit frame`)
      for (const body of frame.bodies) {
        assert.equal(body.opacity, '1', `${needle}: body visible immediately`)
        assert.equal(body.transform, 'none', `${needle}: no vertical travel`)
        assert.equal(body.clip, 'none', `${needle}: no deferred reveal`)
      }
    }
  }
  for (const compact of [false, true]) {
    const gap = compact ? 4 : ROW_GAP
    const query = '&instant=1&compact=' + Number(compact)
    await load('?case=groupOpen' + query)
    await pause(250)
    for (let cycle = 0; cycle < 2; cycle++) {
      await assertInstantToggle('Exploration')
      await assertInstantToggle('Exploration', 1)
      await assertInstantToggle('Exploration', 1)
      await assertInstantToggle('Exploration')
      await assertInstantToggle('edit')
      await assertInstantToggle('edit')
    }
    await load('?case=reasoning' + query)
    await pause(250)
    await assertInstantToggle('Reasoning')
    await assertInstantToggle('Reasoning')
    await load('?case=notice' + query)
    await pause(250)
    await assertInstantToggle('Subagent message')
    await assertInstantToggle('Subagent message')
    for (const needle of ['Subagent completed', 'Task finished']) {
      // Resolve by the real localized trigger rather than relying on a wrapper.
      const actual = await evaluate(`document.querySelector(${JSON.stringify(needle === 'Subagent completed' ? '[data-subagent-completion] [data-agent-trigger]' : '[data-bash-task-id] [data-agent-trigger]')}).textContent`)
      const match = actual.includes('Inspect module') ? 'Inspect module' : 'echo finished'
      await assertInstantToggle(match)
      await assertInstantToggle(match)
    }

    // A settled turn nests the full process under its own disclosure, then
    // ends on prose. The fold does not add a phantom row when closed.
    await load('?case=visible&settled=1' + query)
    await pause(250)
    assert.equal((await evaluate('window.rows()')).items.length, 2, 'closed fold + final prose only')
    assert.match((await evaluate('window.rows()')).items[1].text, /^All done\./, 'a completed reply remains outside the fold')
    await assertInstantToggle('Took')
    const folded = await evaluate(`(() => {
      const body = document.querySelector('[data-turn-process]');
      const trigger = body.parentElement.previousElementSibling.firstElementChild;
      return { gap: body.firstElementChild.getBoundingClientRect().top - trigger.getBoundingClientRect().bottom,
        next: body.parentElement.parentElement.nextElementSibling.getBoundingClientRect().top - body.getBoundingClientRect().bottom };
    })()`)
    assert.equal(folded.gap, ROW_GAP, 'turn fold → first row always keeps the roomy gap')
    assert.equal(folded.next, ROW_GAP, 'folded process → final prose stays roomy')
    await assertInstantToggle('Took')

    await load('?case=leadingProse&settled=1' + query)
    await pause(250)
    await assertInstantToggle('Took')
    const proseGap = await evaluate(`(() => {
      const body = document.querySelector('[data-turn-process]');
      return body.firstElementChild.getBoundingClientRect().top - body.parentElement.previousElementSibling.getBoundingClientRect().bottom;
    })()`)
    assert.equal(proseGap, ROW_GAP, 'a fold starting on prose keeps the roomy leading gap')
    await assertInstantToggle('Took')

    await load('?case=mixed&grouping=0' + query)
    await pause(250)
    const ungrouped = await evaluate('window.rows()')
    assert.equal(ungrouped.items.length, 6, 'grouping off paints five calls and waiting')
    for (let i = 1; i < ungrouped.items.length; i++) {
      assert.equal(ungrouped.items[i].top - ungrouped.items[i - 1].bottom, ungrouped.items[i].roomyBefore ? ROW_GAP : gap, 'ungrouped rows keep the waiting row exception')
    }
  }
  for (const style of ['square', 'squircle']) {
    for (const compact of [0, 1]) {
      await load('?case=groupOpen&instant=1&dark=1&style=' + style + '&compact=' + compact)
      await pause(250)
      await assertInstantToggle('Exploration')
      await assertInstantToggle('Exploration', 1)
      await screenshot('dark-' + style + '-' + compact)
    }
  }
  for (const compact of [0, 1]) {
    await load('?case=boundary&instant=1&compact=' + compact)
    await pause(250)
    const boundaries = await evaluate(`(() => {
      const rows = [...document.querySelector('[data-slot="message-group"]').children];
      return rows.map((row, i) => ({ text: row.innerText.slice(0, 50), gap: i ? row.getBoundingClientRect().top - rows[i-1].getBoundingClientRect().bottom : 0 }));
    })()`)
    assert.equal(boundaries.length, 6, JSON.stringify(boundaries))
    assert.deepEqual(boundaries.slice(1).map(row => row.gap), [24, 24, compact ? 4 : 24, 24, 24],
      'message boundaries, summaries and user turns share the same spacing rule: ' + JSON.stringify(boundaries))
  }
  // The turn rule spans the whole chat column in both corner styles. It is
  // decoration on the header, so it neither rounds with the button nor adds
  // height to the shared 24px line. Check collapsed and expanded geometry.
  for (const style of ['square', 'squircle']) {
    for (const compact of [0, 1]) {
      await load('?case=visible&settled=1&instant=1&style=' + style + '&compact=' + compact)
      await pause(250)
      const divider = await evaluate(`(() => {
        const header = document.querySelector('[data-turn-process]').parentElement.previousElementSibling;
        const trigger = header.firstElementChild;
        const line = getComputedStyle(header, '::after');
        return { width: header.getBoundingClientRect().width, height: header.getBoundingClientRect().height,
          columnWidth: header.closest('[data-transcript-rows]').getBoundingClientRect().width,
          lineWidth: parseFloat(line.width), lineBorder: line.borderBottomWidth, lineRadius: line.borderBottomLeftRadius,
          lineBottom: line.bottom, triggerBorder: getComputedStyle(trigger).borderBottomWidth };
      })()`)
      assert.equal(divider.width, divider.columnWidth, 'fold header spans the chat column')
      assert.equal(divider.lineWidth, divider.columnWidth, 'divider reaches both column edges')
      assert.equal(divider.height, ROW_HEIGHT, 'divider adds no row height')
      assert.equal(divider.lineBorder, '1px', 'divider remains visible')
      assert.equal(divider.lineRadius, '0px', 'divider is straight in both corner styles')
      assert.equal(divider.lineBottom, '0px', 'divider sits on the header bottom edge')
      assert.equal(divider.triggerBorder, '0px', 'rounded button owns no divider')
      await screenshot('fold-closed-' + style + '-' + compact)
      await assertInstantToggle('Took')
      const firstGap = await evaluate(`(() => {
        const body = document.querySelector('[data-turn-process]');
        return body.firstElementChild.getBoundingClientRect().top - body.parentElement.previousElementSibling.getBoundingClientRect().bottom;
      })()`)
      assert.equal(firstGap, ROW_GAP, 'divider → first process row stays roomy')
      await screenshot('fold-open-' + style + '-' + compact)
    }
  }
  // Flipping preferences while a nested row is open preserves its state.
  await load('?case=groupOpen')
  await pause(250)
  await evaluate(`window.openRow('Exploration')`)
  await pause(250)
  await evaluate(`window.openInnerRow('Exploration', 1)`)
  await pause(250)
  await evaluate('window.setInstant(true); window.setDensity(true)')
  const liveFlip = await evaluate(`window.innerBodyFrame('Exploration', 1)`)
  assert.equal(liveFlip.insetTop, 4, 'live density change applies to an open nested body')
  assert.equal(liveFlip.insetBottom, 4, 'live density change applies to its outer boundary')
  await assertInstantToggle('Exploration', 1)
  await assertInstantToggle('Exploration', 1)

  for (const [locale,ui,font] of [['en',14,''],['zh-CN',14,''],['zh-TW',14,''],['zh-CN',12,''],['zh-CN',20,'Arial'],['en',20,'Times New Roman']]) {
    const query = '&instant=1&compact=1&locale='+locale+'&ui='+ui+(font?'&font='+encodeURIComponent(font):'');
    for (const caseName of ['reasoning','groupOpen']) {
      await load('?case='+caseName+query)
      await pause(100)
      const samples = await evaluate('window.labelAlignment()')
      assert.ok(samples.length >= 3, 'actual tool/group/reasoning/waiting labels render')
      for (const sample of samples) {
        assert.ok(Math.abs(sample.offset) < 0.4, 'leading glyph shares the label type centre: '+JSON.stringify({locale,ui,font,...sample}))
        assert.equal(sample.clipped,false,'label keeps CJK glyphs and descenders visible: '+JSON.stringify({locale,ui,font,...sample}))
        assert.ok(sample.baselineOffsets.every(delta=>Math.abs(delta)<0.1),'title and metadata keep one baseline: '+JSON.stringify(sample))
      }
      await screenshot('label-alignment-'+locale+'-'+ui+'-'+caseName)
    }
  }

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('transcript rhythm check ok: shared positive gaps in both densities, nested groups and cards, prose boundaries, instant frame stability, live preferences, images, output caps and multilingual type alignment')
} finally {
  try { ws?.close() } catch {}
  child?.kill('SIGTERM')
  await server?.close()
}
