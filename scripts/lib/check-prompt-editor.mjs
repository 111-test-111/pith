import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Capture the native caret and verify a plan-mode toggle leaves the editing
 * surface untouched. A test-only color makes the caret measurable in pixels. */
async function checkPromptTypography(page, locale) {
  const input = page.locator('[data-prompt-editor]')
  const viewport = page.locator('[data-prompt-viewport]')
  const mode = next => page.evaluate(mode => window.setPlan({ ...window.plan, seq: window.plan.seq + 1, mode }), next)
  const paintedCaret = async () => {
    const box = await viewport.boundingBox()
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt) await page.waitForTimeout(120) // allow a native blink-off interval
      const png = await viewport.screenshot({ caret: 'initial' })
      const pixels = await page.evaluate(async base64 => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d')
        context.drawImage(image, 0, 0)
        const { data, width, height } = context.getImageData(0, 0, image.width, image.height)
        let left = width, top = height, right = -1, bottom = -1
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          if (data[i] > 20 || data[i + 1] < 220 || data[i + 2] > 20) continue
          left = Math.min(left, x); right = Math.max(right, x)
          top = Math.min(top, y); bottom = Math.max(bottom, y)
        }
        return right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1, imageWidth: width }
      }, png.toString('base64'))
      if (pixels) {
        const scale = pixels.imageWidth / box.width
        return { x: box.x + pixels.left / scale, y: box.y + pixels.top / scale, height: pixels.height / scale, width: pixels.width / scale }
      }
    }
    assert.fail('the focused editor must paint a native caret')
  }
  await viewport.evaluate(node => { node.style.caretColor = 'rgb(0, 255, 0)' })
  for (const dark of [false, true]) {
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark)
    await input.fill('')
    await mode('normal')
    const plain = await paintedCaret()
    await mode('plan')
    const planned = await paintedCaret()
    assert.ok(Math.abs(planned.height - plain.height) <= 1, `changing mode must not enlarge the painted caret: ${JSON.stringify({ plain, planned })}`)
    assert.ok(Math.abs(planned.y - plain.y) <= 1, 'changing mode must not lower the caret')
    assert.ok(Math.abs(planned.x - plain.x) <= 1, 'changing mode must not move the caret into the draft')
    assert.ok(planned.width <= 2, 'the measurement identifies the caret, not a text glyph')
    const origin = await input.evaluate(node => node.getBoundingClientRect().left)
    assert.ok(Math.abs(planned.x - origin) <= 1, 'the painted caret starts at the draft origin')

    for (const sample of ['111', '规划', 'Plan']) {
      await input.fill(sample)
      const geometry = await input.evaluate(node => {
        return { lineHeight: node.parentElement.getBoundingClientRect().height, expectedLineHeight: parseFloat(getComputedStyle(node).lineHeight) }
      })
      assert.equal(geometry.lineHeight, geometry.expectedLineHeight, `${sample} keeps one text row`)
    }
    await input.fill('')
    const cleared = await paintedCaret()
    assert.ok(Math.abs(cleared.height - plain.height) <= 1, 'clearing the draft keeps the text-sized caret')
    if (process.env.PI_PLAN_SCREENSHOT_DIR) {
      await mkdir(process.env.PI_PLAN_SCREENSHOT_DIR, { recursive: true })
      await viewport.evaluate(node => { node.style.caretColor = '' })
      await viewport.screenshot({ path: join(process.env.PI_PLAN_SCREENSHOT_DIR, `editor-${locale}-${dark ? 'dark' : 'light'}-native-caret.png`), caret: 'initial' })
      await input.fill('111')
      await viewport.screenshot({ path: join(process.env.PI_PLAN_SCREENSHOT_DIR, `editor-${locale}-${dark ? 'dark' : 'light'}-text.png`), caret: 'initial' })
      await viewport.evaluate(node => { node.style.caretColor = 'rgb(0, 255, 0)' })
    }
  }
  await input.fill('')
  await viewport.evaluate(node => { node.style.caretColor = '' })
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
}

/** Real native editing, not a CSS mirror: regress the three reported carets. */
export async function checkPromptEditor(page, locale) {
  await checkPromptTypography(page, locale)
  const input = page.locator('[data-prompt-editor]')
  const viewport = page.locator('[data-prompt-viewport]')
  const text = () => input.evaluate(node => node.innerText.replace(/\n$/, ''))
  const caret = () => input.evaluate(editor => {
    const selection = getSelection()
    const range = selection.getRangeAt(0)
    const before = document.createRange()
    before.selectNodeContents(editor)
    before.setEnd(range.startContainer, range.startOffset)
    // Collapsed ranges at a BR or LF may have no rect. Read that native
    // line-break fragment without moving the live selection or editing DOM.
    let rect = range.getClientRects()[0]
    if (!rect && range.startContainer.nodeType === Node.TEXT_NODE) {
      const probe = range.cloneRange()
      if (range.startOffset < range.startContainer.length) {
        probe.setEnd(range.startContainer, range.startOffset + 1)
        rect = probe.getClientRects()[0]
      } else rect = range.startContainer.nextSibling?.getBoundingClientRect?.()
    }
    rect ??= range.startContainer.childNodes[range.startOffset]?.getBoundingClientRect?.()
    const content = editor.parentElement.getBoundingClientRect()
    return { x: rect?.x, y: rect?.y, left: content.left,
      html: editor.innerHTML, node: range.startContainer.nodeName, nodeText: range.startContainer.textContent, localOffset: range.startOffset, offset: before.toString().length, inside: editor.contains(range.startContainer) }
  })
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected}`)
  const screenshot = async name => {
    if (!process.env.PI_PLAN_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_PLAN_SCREENSHOT_DIR, { recursive: true })
    await viewport.screenshot({ path: join(process.env.PI_PLAN_SCREENSHOT_DIR, `editor-${locale}-${name}.png`) })
  }

  await input.focus()
  const first = await caret()
  near(first.x, first.left, 'the empty first-line caret starts at the draft origin')
  await input.press('Shift+Enter')
  assert.equal(await text(), '\n')
  const emptySecond = await caret()
  near(emptySecond.x, emptySecond.left, 'a newline starts at the left edge')
  near(emptySecond.y - first.y, 24, 'one newline is exactly one row')
  await screenshot('empty-second-line')
  await input.press('1')
  await input.press('ArrowLeft')
  near((await caret()).x, emptySecond.x, 'typing does not move the second line origin')
  await input.press('ArrowRight')
  await input.press('Backspace')
  near((await caret()).x, emptySecond.x, 'deleting text keeps the empty second-line caret')
  await input.press('Backspace')
  assert.equal(await text(), '')
  near((await caret()).x, first.x, 'deleting the newline returns the caret to the first line')
  await screenshot('back-to-start')
  await input.press('ArrowLeft')
  await input.press('Backspace')
  assert.equal((await caret()).inside, true, 'the caret stays inside the editing host')
  near((await caret()).x, first.x, 'backspace at the draft start keeps the origin')

  // Hit testing in the empty field must focus its editing host too.
  await input.fill('\n1')
  await input.press('ArrowUp')
  near((await caret()).x, first.x, 'ArrowUp returns to the first line')
  await input.fill('')
  await input.evaluate(node => node.blur())
  await viewport.click({ position: { x: 300, y: 40 } })
  assert.equal(await input.evaluate(node => node === document.activeElement), true)
  near((await caret()).x, first.x, 'clicking empty field space places the caret at the draft origin')

  await input.press('Shift+Enter')
  await input.press('Shift+Enter')
  near((await caret()).x, first.left, 'consecutive blank lines stay flush left')
  // Move the caret to end the browser's newline typing transaction.
  await input.press('ArrowLeft')
  await input.press('ArrowRight')
  await page.keyboard.insertText('中文 👩‍💻')
  assert.equal(await text(), '\n\n中文 👩‍💻')
  await input.press('ControlOrMeta+z')
  assert.equal(await text(), '\n\n', 'undo removes the native insertion without touching the prefix')
  await input.press('ControlOrMeta+Shift+z')
  assert.equal(await text(), '\n\n中文 👩‍💻', 'redo restores the exact Unicode draft')

  // Selection/replacement operates on user text only; trailing newlines are
  // preserved without leaking BRs or zero-width text.
  await input.fill('first\n\nlast\n')
  assert.equal(await text(), 'first\n\nlast\n')
  await input.press('ControlOrMeta+a')
  assert.equal(await page.evaluate(() => getSelection().toString()), 'first\n\nlast\n')
  await page.keyboard.insertText('replacement')
  assert.equal(await text(), 'replacement')
  assert.equal(await page.locator('[data-plan-mode-control]').getAttribute('aria-pressed'), 'true')

  await input.fill('规划模式 plan mode '.repeat(24))
  const lines = await input.evaluate(editor => {
    const range = document.createRange()
    range.selectNodeContents(editor)
    const rows = new Map()
    for (const rect of range.getClientRects()) {
      const top = Math.round(rect.top)
      rows.set(top, Math.min(rows.get(top) ?? Infinity, rect.left))
    }
    return [...rows.values()]
  })
  assert.ok(lines.length > 2)
  near(lines[0], first.x, 'wrapped text starts at the draft origin')
  for (const left of lines.slice(1)) near(left, first.left, 'every wrapped line starts at the field edge')
  await input.fill(Array.from({ length: 14 }, (_, i) => `line ${i}`).join('\n'))
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-prompt-viewport]')
    return Math.abs(v.clientHeight - 198) <= 1
  })
  await input.press('ControlOrMeta+End')
  await input.press('Shift+Enter')
  await page.keyboard.insertText('tail')
  assert.ok(await input.evaluate(node => {
    const caret = getSelection().getRangeAt(0).getBoundingClientRect()
    const viewport = node.closest('[data-prompt-viewport]').getBoundingClientRect()
    return caret.top >= viewport.top && caret.bottom <= viewport.bottom + 1
  }), 'typing beyond the row cap keeps the native caret visible')
  await viewport.evaluate(node => { node.scrollTop = node.scrollHeight })
  assert.ok(await viewport.evaluate(node => node.scrollTop > 0 && getComputedStyle(node).scrollbarWidth === 'none'))
  assert.ok(await page.locator('[data-plan-mode-control]').isVisible(), 'the plan control stays visible while the draft scrolls')

  // Mode changes keep the SAME editable node and native undo history.
  await input.fill('retained draft')
  await input.press('ArrowLeft')
  const selection = await caret()
  await input.evaluate(node => { window.originalPromptEditor = node })
  await page.evaluate(() => window.setPlan({ ...window.plan, seq: window.plan.seq + 1, mode: 'normal' }))
  assert.equal(await input.evaluate(node => node === window.originalPromptEditor), true)
  await page.keyboard.insertText('!')
  assert.equal(await text(), 'retained draf!t')
  await page.evaluate(() => window.setPlan({ ...window.plan, seq: window.plan.seq + 1, mode: 'plan' }))
  await input.press('ControlOrMeta+z')
  assert.equal(await text(), 'retained draft')
  assert.equal((await caret()).offset, selection.offset)
  await input.fill('')
  await viewport.evaluate(node => { node.scrollTop = 0 })

  // Composition is a real Chromium IME transaction. Re-rendering the mode
  // while composing must not replace its text node or submit its Enter.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: '规', selectionStart: 1, selectionEnd: 1 })
  await input.evaluate(node => { window.composingText = node.firstChild })
  await page.evaluate(() => window.setPlan({ ...window.plan, seq: window.plan.seq + 1, mode: 'normal' }))
  assert.equal(await input.evaluate(node => node.firstChild === window.composingText), true)
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  assert.equal(await page.evaluate(() => window.sent.length), 0)
  await cdp.send('Input.insertText', { text: '规划' })
  assert.equal(await text(), '规划')

  // macOS Pinyin can retain "provid" as preedit while the English candidate
  // for "provide" advances its selection one character beyond that text.
  // An inline host resolves that offset into the next model-picker label,
  // so the candidate commit leaves the draft and can rewrite UI text.
  for (const prefix of ['', 'first\n']) {
    await input.fill(prefix)
    await input.press('ControlOrMeta+End')
    for (const preedit of ['p', 'p r', 'pro', 'p ro v', 'provi', 'provid']) {
      await cdp.send('Input.imeSetComposition', { text: preedit, selectionStart: preedit.length, selectionEnd: preedit.length })
    }
    await input.evaluate(node => { window.composingText = node.firstChild })
    await cdp.send('Input.imeSetComposition', { text: 'provid', selectionStart: 7, selectionEnd: 7 })
    assert.equal(await text(), `${prefix}provid`, 'a pending English candidate keeps its native preedit')
    assert.ok(await input.evaluate(node => {
      const selection = getSelection()
      return node.contains(selection.anchorNode) && node.contains(selection.focusNode) && node === document.activeElement
    }), 'the English-candidate selection and focus stay inside the draft')
    assert.equal(await input.evaluate(node => node.firstChild === window.composingText), true, 'candidate updates preserve the native composition node')
    await cdp.send('Input.insertText', { text: 'provider' })
    assert.equal(await text(), `${prefix}provider`, 'the English candidate commits into the draft')
    assert.equal(await input.evaluate(node => node === document.activeElement), true, 'candidate commit preserves composer focus')
  }
  await page.evaluate(() => window.setPlan({ ...window.plan, seq: window.plan.seq + 1, mode: 'plan' }))
  await cdp.detach()

  // Native rich-text insertion follows the host's plaintext-only policy.
  await input.fill('')
  await input.evaluate(node => { node.focus(); document.execCommand('insertHTML', false, '<b>plain</b><div>text</div>') })
  assert.equal(await text(), 'plain\ntext')
  assert.equal(await input.locator('b, div, span, img').count(), 0)

  // The @ picker uses draft offsets after a leading blank line. Its
  // programmatic replacement puts the caret after the reference.
  await page.evaluate(() => { window.pi.searchFiles = async () => [{ path: '/tmp/notes.md', relPath: 'notes.md', name: 'notes.md', dir: '', kind: 'text', size: 6 }] })
  await input.fill('\n@notes')
  await page.getByText('notes.md', { exact: true }).waitFor()
  await input.press('Enter')
  assert.equal(await text(), '\n@notes.md ')
  await input.press('ControlOrMeta+z')
  assert.equal(await text(), '\n@notes', 'a mention replacement is one native undo transaction')
  await input.press('ControlOrMeta+Shift+z')
  assert.equal(await text(), '\n@notes.md ')
  await page.keyboard.insertText('ok')
  assert.equal(await text(), '\n@notes.md ok')
  await page.locator('[data-attachment-card]').getByRole('button').last().click()
  assert.equal(await text(), 'ok')

  await page.evaluate(() => window.setAppendDraft({ text: 'annotation\nsecond line', seq: 1 }))
  await page.waitForFunction(() => document.querySelector('[data-prompt-editor]').innerText.replace(/\n$/, '') === 'ok\n\nannotation\nsecond line')
  await page.keyboard.insertText('!')
  assert.equal(await text(), 'ok\n\nannotation\nsecond line!')
  await page.evaluate(() => window.setReadOnly(true))
  assert.equal(await input.isEditable(), false)
  await page.evaluate(() => window.setReadOnly(false))
  await input.fill('only user text\nsecond line')
  await input.press('Enter')
  assert.equal(await page.evaluate(() => window.sent.at(-1).text), 'only user text\nsecond line')
  assert.equal(await text(), '')
  near((await caret()).x, first.x, 'sending restores the empty caret to the draft origin')
  await page.evaluate(() => { window.sent = [] })
}
