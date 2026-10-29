import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

// One vector master; no platform tools or font installation required.
const root = new URL('../', import.meta.url)
const svg = await readFile(new URL('resources/pith.svg', root), 'utf8')
const output = new URL('resources/icons/', root)
await mkdir(output, { recursive: true })
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const images = new Map()
for (const size of sizes) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  images.set(size, png)
  await writeFile(new URL(`${size}x${size}.png`, output), png)
}

// Windows ICO: directory entries + PNG frames (supported since Windows Vista).
const icoSizes = sizes.filter((size) => size <= 256)
const icoHeader = Buffer.alloc(6 + 16 * icoSizes.length)
icoHeader.writeUInt16LE(1, 2)
icoHeader.writeUInt16LE(icoSizes.length, 4)
let offset = icoHeader.length
icoSizes.forEach((size, index) => {
  const frame = images.get(size)
  const entry = 6 + index * 16
  icoHeader[entry] = icoHeader[entry + 1] = size === 256 ? 0 : size
  icoHeader.writeUInt16LE(1, entry + 4)
  icoHeader.writeUInt16LE(32, entry + 6)
  icoHeader.writeUInt32LE(frame.length, entry + 8)
  icoHeader.writeUInt32LE(offset, entry + 12)
  offset += frame.length
})
await writeFile(new URL('icon.ico', output), Buffer.concat([icoHeader, ...icoSizes.map((size) => images.get(size))]))

// macOS ICNS: standard and Retina PNG representations, up to 512pt @2x.
const icnsTypes = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 }
const chunks = Object.entries(icnsTypes).map(([type, size]) => {
  const png = images.get(size)
  const header = Buffer.alloc(8)
  header.write(type)
  header.writeUInt32BE(8 + png.length, 4)
  return Buffer.concat([header, png])
})
const icnsHeader = Buffer.alloc(8)
icnsHeader.write('icns')
icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
await writeFile(new URL('icon.icns', output), Buffer.concat([icnsHeader, ...chunks]))
console.log(`Pith icons generated in ${fileURLToPath(output)}`)
