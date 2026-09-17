/**
 * 内嵌浏览器的 CDP 端口：启动前选定端口并挂 Chromium 调试开关。
 * 移植自 pi-web electron/main.cjs 的 pickCdpPort + appendSwitch 两行（语义照抄），
 * 按 pi-app 需求精确化：PITH_CDP_PORT 合法（1–65535 整数）优先，否则随机高端口
 * 19000–38999。端口记入模块变量——service 初始化（ipc.ts）经 getCdpPort() 取走
 * 与 Chromium 实际生效一致的同一端口。
 */
import { createRequire } from 'node:module'

/**
 * app.commandLine 只存在于 Electron 主进程。检查脚本（scripts/check-browser.mjs）
 * 在纯 node 下导入本模块断言纯函数——静态 `import { app } from 'electron'` 会在
 * node 下因命名导出缺失直接链接失败，所以 appendCdpSwitches 在调用点惰性 require
 * （Electron 主进程内 import.meta.url 可解析到 node_modules 的 electron 包）。
 */
const requireElectron = createRequire(import.meta.url)

/** 已选定/已挂开关的端口（appendCdpSwitches 的入参为准——那是 Chromium 实际生效的端口）。 */
let cdpPort: number | null = null

/** PITH_CDP_PORT 合法（1–65535 整数）则用之，否则 19000 + rand(20000)（即 19000–38999）。 */
export function pickCdpPort(): number {
  const raw = process.env.PITH_CDP_PORT
  const parsed = raw ? Number(raw) : NaN
  const port = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? parsed
    : 19000 + Math.floor(Math.random() * 20000)
  cdpPort = port
  return port
}

/** 把端口挂成 Chromium 开关（必须在 app ready 前调用——index.ts 模块顶部）。 */
export function appendCdpSwitches(port: number): void {
  cdpPort = port
  const { app } = requireElectron('electron') as typeof import('electron')
  app.commandLine.appendSwitch('remote-debugging-port', String(port))
  app.commandLine.appendSwitch('remote-allow-origins', 'http://127.0.0.1')
}

/** 当前生效端口（service 初始化注入用）；此前未 pick 过时惰性 pick 一次。 */
export function getCdpPort(): number {
  return cdpPort ?? pickCdpPort()
}
