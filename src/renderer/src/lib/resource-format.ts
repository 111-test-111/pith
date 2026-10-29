/** Binary units are labelled accurately; keep exact bytes alongside the
 * compact display in the resource panel instead of treating it as an estimate. */
export function resourceBytes(bytes: number, locale: string): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const index = bytes === 0 ? 0 : Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: index ? 2 : 0 }).format(bytes / 1024 ** index)} ${units[index]}`
}
