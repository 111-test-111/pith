/** Deterministic macOS wheel streams: direction noise, inertia and modifiers. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = await mkdtemp(join(tmpdir(), 'pith-wheel-'))
try {
  const outfile = join(temporary, 'wheel.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../src/renderer/src/lib/wheel-gesture.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile })
  const { createWheelGesture, wheelPixels, WHEEL_GESTURE_IDLE } = await import(pathToFileURL(outfile).href)
  const input = (deltaX, deltaY, extra = {}) => ({ deltaX, deltaY, deltaMode: 0, ctrlKey: false, shiftKey: false, ...extra })
  let choices = 0
  const gesture = createWheelGesture((event, axis) => { choices++; return event.ctrlKey ? 'pinch' : axis === 'x' ? 'pan' : 'zoom' })
  assert.equal(gesture.read(input(0, 0), 0), null, 'zero events cannot choose a direction')
  assert.deepEqual(gesture.read(input(18, 12), 0), {axis:'x',mode:'pan',deltaX:18,deltaY:0})
  assert.deepEqual(gesture.read(input(12, 19), 40), {axis:'x',mode:'pan',deltaX:12,deltaY:0}, 'a diagonal stream cannot change action when its secondary delta grows')
  assert.deepEqual(gesture.read(input(4, 100), 120), {axis:'x',mode:'pan',deltaX:4,deltaY:0}, 'accelerated momentum keeps the original direction')
  assert.equal(choices, 1, 'choose an action once per gesture')
  assert.equal(gesture.read(input(0, 3), 200).axis, 'x', 'pure secondary noise remains suppressed during inertia')
  const fresh = 200 + WHEEL_GESTURE_IDLE + 1
  assert.deepEqual(gesture.read(input(8, -12), fresh), {axis:'y',mode:'zoom',deltaX:0,deltaY:-12}, 'an idle gap admits a new direction')
  assert.deepEqual(gesture.read(input(20, -8), fresh + 20), {axis:'y',mode:'zoom',deltaX:0,deltaY:-8})
  assert.deepEqual(gesture.read(input(100, -4, {ctrlKey:true}), fresh + 30), {axis:'y',mode:'pinch',deltaX:0,deltaY:-4}, 'pinch overrides the current gesture')
  assert.deepEqual(gesture.read(input(30, 10), fresh + 40), {axis:'x',mode:'pan',deltaX:30,deltaY:0}, 'releasing a modifier begins a fresh intent')
  assert.deepEqual(gesture.read(input(1, 24, {shiftKey:true}), fresh + 50), {axis:'x',mode:'pan',deltaX:24,deltaY:0}, 'Shift maps a vertical mouse wheel to horizontal')
  assert.equal(gesture.read(input(24, 1, {shiftKey:true}), fresh + 60).deltaX, 24, 'already-mapped Shift wheel retains its horizontal magnitude')
  assert.deepEqual(wheelPixels(input(2, 3, {deltaMode:1}), {clientWidth:400,clientHeight:300}), input(32,48,{deltaMode:1}))
  assert.deepEqual(wheelPixels(input(2, 3, {deltaMode:2}), {clientWidth:400,clientHeight:300}), input(800,900,{deltaMode:2}), 'page units use the extent of their own axis')
  gesture.reset()
  assert.equal(gesture.read(input(0, 5), fresh + 70).axis, 'y', 'changing surfaces may explicitly reset ownership')
  console.log('PASS wheel gestures: diagonal noise, locked intent/axis, momentum, idle reset, pinch/Shift overrides and pixel/line/page units')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
