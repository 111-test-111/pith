/** Five buckets: 0 is the neutral empty cell, 1 to 4 mix the one hue in harder. */
export const STEPS = [0, 24, 46, 70, 94] as const;

export const EMPTY = "color-mix(in srgb, var(--foreground) 6%, transparent)";

/** Cell size and gap; every position in the grid and the tooltip derive from these. */
export const CELL = 16;

export const GAP = 4;

export const PITCH = CELL + GAP;

export const MONTH_ROW = 12;

export const DAYS = Array.from({ length: 7 }, (_, d) => ({ id: `d${d}`, d }));

export const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};

export const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};

/** Monday on or before `d`, so every column reads Mon to Sun, top to bottom. */
export const mondayOf = (d: Date) => addDays(startOfDay(d), -((d.getUTCDay() + 6) % 7));

/** Formatters follow the app locale. The vendored constants were pinned to
 * en-US, which left the daily grid's month labels English inside a zh-CN
 * interface while the weekly view (formatted by the app) was localized. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions, locale?: string): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${options.month ?? ""}|${options.weekday ?? ""}|${options.day ?? ""}|${options.year ?? ""}`;
  let format = FORMATTERS.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options });
    FORMATTERS.set(key, format);
  }
  return format;
}

/** `fmtDay(locale).format(date)` — one cached formatter per locale and shape. */
export const fmtDay = (locale?: string) =>
  formatter({ weekday: "short", month: "short", day: "numeric" }, locale);

export const fmtMonth = (locale?: string) => formatter({ month: "short" }, locale);

export const fmtRange = (locale?: string) =>
  formatter({ month: "short", day: "numeric" }, locale);
