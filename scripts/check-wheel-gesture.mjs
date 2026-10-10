/** Wheel normalization preserves diagonal motion and immediate direction changes. */
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
  const { wheelPixels } = await import(pathToFileURL(outfile).href)
  const input = (deltaX, deltaY, extra = {}) => ({ deltaX, deltaY, deltaMode: 0, ctrlKey: false, shiftKey: false, ...extra })
  const viewport = {clientWidth:400,clientHeight:300}
  const stream = [[18,12],[12,19],[4,100],[0,3],[-8,-12],[20,-8],[0,-10],[-10,0]]
  assert.deepEqual(stream.map(([x,y])=>wheelPixels(input(x,y),viewport)),stream.map(([x,y])=>input(x,y)), 'every event retains both axes, including momentum and immediate direction reversals')
  assert.deepEqual(wheelPixels(input(0,0),viewport),input(0,0),'zero events do not add motion')
  assert.deepEqual(wheelPixels(input(100,-4,{ctrlKey:true}),viewport),input(100,-4,{ctrlKey:true}),'pinch retains its input for the owning zoom handler')
  assert.deepEqual(wheelPixels(input(1,24,{shiftKey:true}),viewport),input(24,0,{shiftKey:true}),'Shift maps a vertical mouse wheel to horizontal')
  assert.deepEqual(wheelPixels(input(24,1,{shiftKey:true}),viewport),input(24,0,{shiftKey:true}),'already-mapped Shift wheel retains its horizontal magnitude')
  assert.deepEqual(wheelPixels(input(1,-24,{shiftKey:true}),viewport),input(-24,0,{shiftKey:true}),'Shift preserves the wheel direction')
  assert.deepEqual(wheelPixels(input(100,-4,{ctrlKey:true,shiftKey:true}),viewport),input(100,-4,{ctrlKey:true,shiftKey:true}),'Shift does not remap pinch zoom')
  assert.deepEqual(wheelPixels(input(2, 3, {deltaMode:1}), {clientWidth:400,clientHeight:300}), input(32,48,{deltaMode:1}))
  assert.deepEqual(wheelPixels(input(2, 3, {deltaMode:2}), {clientWidth:400,clientHeight:300}), input(800,900,{deltaMode:2}), 'page units use the extent of their own axis')
  assert.deepEqual(wheelPixels(input(2,3,{deltaMode:1}),viewport,40),input(80,120,{deltaMode:1}),'browser forwarding retains its 40px line step')
  console.log('PASS wheel gestures: free diagonal motion, immediate direction changes, pinch/Shift and pixel/line/page units')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
