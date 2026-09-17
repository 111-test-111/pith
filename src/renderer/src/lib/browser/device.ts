/**
 * 内嵌浏览器的设备模拟（viewport 预设）。renderer 端元素级实现：设备模式下直接把
 * webview 元素尺寸钉在预设宽高（guest 视口天然跟随元素尺寸——与批注坐标系的
 * 「guest 视口 == 元素」不变量一致），不走 CDP setDeviceMetricsOverride（会破坏该
 * 不变量且渲染形态不可控）。纯数据/纯函数，便于 node 直测。
 * 移植自 pi-web lib/browser-device.ts（逐成员照抄，无键名/依赖改动）。
 */

export interface DevicePreset {
  id: string
  name: string
  width: number
  height: number
}

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { id: 'iphone-se', name: 'iPhone SE', width: 375, height: 667 },
  { id: 'iphone-15-pro', name: 'iPhone 15 Pro', width: 393, height: 852 },
  { id: 'pixel-8', name: 'Pixel 8', width: 412, height: 915 },
  { id: 'galaxy-s23', name: 'Galaxy S23', width: 360, height: 780 },
  { id: 'ipad-air', name: 'iPad Air', width: 820, height: 1180 },
]

/** 自定义档位 id（宽高输入框编辑时落入；select 里仅处于该档时出现）。 */
export const CUSTOM_DEVICE_ID = 'custom'

export const DEVICE_SIZE_MIN = 200
export const DEVICE_SIZE_MAX = 3840

export function clampDeviceSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEVICE_SIZE_MIN
  return Math.min(Math.max(Math.round(value), DEVICE_SIZE_MIN), DEVICE_SIZE_MAX)
}

export function findDevicePreset(id: string): DevicePreset | null {
  return DEVICE_PRESETS.find((p) => p.id === id) ?? null
}
