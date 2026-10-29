import assert from 'node:assert/strict'

// Capture Chromium's painted frames, including shared-layout backgrounds
// outside a row's DOM subtree. A real mouse and a changed hover pixel are the
// positive control; computed classes alone cannot catch an exit flash.
export async function pointerHoverStory(page, item, away) {
  await item.waitFor({ state: 'visible' })
  await page.mouse.move(away.x, away.y)
  await page.waitForTimeout(240)
  const box = await item.boundingBox()
  assert.ok(box, 'hover target is visible')
  const original = await item.elementHandle()
  const point = { x: Math.floor(box.x + box.width - 4), y: Math.floor(box.y + box.height / 2) }
  const pixel = async data => page.evaluate(async ({ data, point }) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    const x = Math.floor(point.x * bitmap.width / window.innerWidth)
    const y = Math.floor(point.y * bitmap.height / window.innerHeight)
    bitmap.close()
    return Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3)
  }, { data, point })
  const screenshot = async () => pixel((await page.screenshot({ scale: 'css' })).toString('base64'))
  const rest = await screenshot()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(240)
  assert.equal(await item.evaluate(node => node.matches(':hover')), true, 'real pointer enters the row')
  const hovered = await screenshot()
  const cdp = await page.context().newCDPSession(page)
  const frames = []
  cdp.on('Page.screencastFrame', frame => {
    frames.push(frame.data)
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  await page.mouse.move(away.x, away.y)
  await page.waitForTimeout(320)
  await cdp.send('Page.stopScreencast')
  await cdp.detach()
  assert.equal(await item.evaluate(node => node.matches(':hover')), false, 'real pointer leaves the row')
  const left = await screenshot()
  assert.equal(await original.evaluate(node => node.isConnected), true, 'hover and leave retain the same row')
  assert.deepEqual(await item.boundingBox(), box, 'hover and leave keep the row geometry stable')
  await original.dispose()
  return { rest, hovered, left, frames: await Promise.all(frames.map(pixel)) }
}

export function assertHoverSettles(story, label) {
  const distance = color => Math.max(...color.map((v, i) => Math.abs(v - story.rest[i])))
  assert.ok(distance(story.hovered) >= 4, label + ': hover visibly fills the row')
  assert.ok(distance(story.left) <= 1, label + ': leaving clears the fill')
  assert.ok(story.frames.length >= 2, label + ': Chromium delivered painted exit frames')
  assert.ok(story.frames.some(color => distance(color) > 0 && distance(color) < distance(story.hovered)), label + ': hover fades on the row instead of disappearing in one frame')
  let previous = distance(story.hovered)
  for (const color of story.frames) {
    const next = distance(color)
    assert.ok(next <= previous + 2, `${label}: exit never repaints a brighter hover fill (${previous} -> ${next}); ${JSON.stringify(story)}`)
    previous = next
  }
}
