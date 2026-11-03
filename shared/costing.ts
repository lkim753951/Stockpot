/** The sums behind every margin the owner sees. The server and the browser both use these, so no two screens disagree. */

/** Margin as a percent to one decimal place. Null when there is no price to work from. */
export function marginPercent(pricePence: number, costPence: number) {
  return pricePence > 0 ? Math.round(((pricePence - costPence) / pricePence) * 1000) / 10 : null
}

/** The menu price that reaches a target margin, rounded up to the next penny so it never falls short. */
export function priceForMargin(costPence: number, targetMargin: number) {
  return targetMargin >= 100 ? null : Math.ceil(Number((costPence / (1 - targetMargin / 100)).toFixed(6)))
}

/** Prep time is for the whole recipe. This is what it comes to for one portion. */
export const prepPerPortion = (prepMinutes: number | null | undefined, portions: number | null | undefined) =>
  (prepMinutes && portions ? Math.round((prepMinutes / portions) * 10) / 10 : null)
