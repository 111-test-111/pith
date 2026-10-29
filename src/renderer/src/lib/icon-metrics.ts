/**
 * SVG canvas sizes; CSS can still size status geometry and other small marks.
 * `compact` is the chrome canvas: the title row's controls and the sessions
 * sidebar draw it, so the two surfaces keep the same optical size.
 */
export const UI_ICON_SIZE = { compact: 16, normal: 18, primary: 20 } as const
/** Hugeicons centerline weight; Remix Line's filled outlines encode their own. */
export const UI_ICON_STROKE = 1.5

/** Both file artwork styles retain these shared surface sizes. */
export const FILE_ICON_SIZE = { tree: 16, tab: 16, card: 18 } as const
