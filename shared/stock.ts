/** The pack sizes a stock count can use, in litres. A crate holds 6 boxes. */
export const BOX_LITRES = 5
export const BOXES_IN_CRATE = 6
export const PACKS = { container: 1, box: BOX_LITRES, crate: BOXES_IN_CRATE * BOX_LITRES } as const
export type Pack = keyof typeof PACKS

export const isPack = (value: unknown): value is Pack => typeof value === 'string' && Object.hasOwn(PACKS, value)
export const litresOf = (count: number, pack: Pack) => count * PACKS[pack]

/** Kilos per litre a food can reasonably be, from loose herbs to golden syrup. Anything outside isn't a density. */
export const DENSITY_MIN = 0.02
export const DENSITY_MAX = 2
export const isDensity = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= DENSITY_MIN && value <= DENSITY_MAX
