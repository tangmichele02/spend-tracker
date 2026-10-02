const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const usdWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 })

// `|| 0` turns negative zero into zero so it never prints as −$0.00.
export const money = (cents: number) => usd.format((cents || 0) / 100).replace('-', '−')
export const moneyWhole = (cents: number) => usdWhole.format(Math.round(cents / 100)).replace('-', '−')
export const moneyCompact = (cents: number) => compact.format(cents / 100).replace('-', '−')
/** For putting an amount back into a text field. */
export const amountField = (cents: number) => (Math.abs(cents) / 100).toFixed(2)
export const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–')

/** Earliest year the pickers offer; there is no data before it. */
export const MIN_YEAR = 2025

export const today = () => new Date().toLocaleDateString('en-CA')
export const currentMonth = () => today().slice(0, 7)

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + by, 1))
  return d.toISOString().slice(0, 7)
}
export function monthLabel(month: string, style: 'long' | 'short' = 'long'): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', style === 'long'
    ? { month: 'long', year: 'numeric', timeZone: 'UTC' }
    : { month: 'short', timeZone: 'UTC' })
}
export function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}
export function dateLabel(iso: string, withYear = false): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: withYear ? 'numeric' : undefined, timeZone: 'UTC',
  })
}
