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

/** 无模拟档位 id：铺满宿主区（未启用设备模拟）。下拉里这一行禁用——关闭模拟
 *  只能通过「切换选中页重置为无」这条路径（本任务规格），面板内不提供开关。 */
export const DEVICE_NONE_ID = 'none'

/** 面板持有的设备模拟状态：档位 id + 最近一次提交的宽高。预设档的宽高跟随
 *  预设；custom 档使用这里提交的数值；none 档忽略宽高。 */
export interface DeviceEmulationState {
  presetId: string
  width: number
  height: number
}

/** 无模拟初始态：宽高取第一个预设作种子（首次切到 custom 时有合理值可显示）。 */
export const INITIAL_DEVICE_STATE: DeviceEmulationState = {
  presetId: DEVICE_NONE_ID,
  width: DEVICE_PRESETS[0].width,
  height: DEVICE_PRESETS[0].height,
}

/** 设备模式钉在 webview 元素上的最终尺寸；null = 未启用（铺满宿主区）。 */
export function resolveDeviceSize(state: DeviceEmulationState): { width: number; height: number } | null {
  const preset = findDevicePreset(state.presetId)
  if (preset) return { width: preset.width, height: preset.height }
  if (state.presetId === CUSTOM_DEVICE_ID) return { width: state.width, height: state.height }
  return null
}

/** 宽高输入的 onChange 过滤：仅数字，最多 4 位（3840 上限本身 4 位）。 */
export function sanitizeDeviceDigits(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 4)
}

/** 失焦提交一维草稿：空串/非法数字回退原值，其余夹取 200–3840（先取整）。
 *  编辑中的草稿不打扰已生效尺寸——只有 blur 才提交（规格：编辑 “393” 不被截断）。 */
export function commitDeviceSize(raw: string, previous: number): number {
  const trimmed = raw.trim()
  if (trimmed === '') return previous
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return previous
  return clampDeviceSize(parsed)
}

/** 提交后的档位解析：宽高与某预设完全一致 → 该预设 id；否则 custom（规格：
 *  「与预设不一致时落入 custom」）。 */
export function resolveDevicePresetId(width: number, height: number): string {
  const match = DEVICE_PRESETS.find((p) => p.width === width && p.height === height)
  return match ? match.id : CUSTOM_DEVICE_ID
}

export const DEVICE_SIZE_MIN = 200
export const DEVICE_SIZE_MAX = 3840

export function clampDeviceSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEVICE_SIZE_MIN
  return Math.min(Math.max(Math.round(value), DEVICE_SIZE_MIN), DEVICE_SIZE_MAX)
}

export function findDevicePreset(id: string): DevicePreset | null {
  return DEVICE_PRESETS.find((p) => p.id === id) ?? null
}
