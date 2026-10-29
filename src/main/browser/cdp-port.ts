/** Select and install the embedded browser's CDP port before app readiness.
 * PITH_CDP_PORT accepts integers 1-65535; otherwise choose 19000-38999.
 * The service reads the same installed port. Lazy Electron access keeps the
 * pure helpers importable by Node checks. */
import { createRequire } from 'node:module'

const requireElectron = createRequire(import.meta.url)

let cdpPort: number | null = null

export function pickCdpPort(): number {
  const raw = process.env.PITH_CDP_PORT
  const parsed = raw ? Number(raw) : NaN
  const port = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? parsed
    : 19000 + Math.floor(Math.random() * 20000)
  cdpPort = port
  return port
}

/** Call before app readiness; Chromium must receive the selected port. */
export function appendCdpSwitches(port: number): void {
  cdpPort = port
  const { app } = requireElectron('electron') as typeof import('electron')
  app.commandLine.appendSwitch('remote-debugging-port', String(port))
  app.commandLine.appendSwitch('remote-allow-origins', 'http://127.0.0.1')
}

export function getCdpPort(): number {
  return cdpPort ?? pickCdpPort()
}
