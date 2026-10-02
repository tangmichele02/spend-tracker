// Parsing for pasted spreadsheet blocks. Shared so the server tests can cover it.

export function parseAmount(raw: string): number | null {
  let s = raw.trim()
  if (!s) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  s = s.replace(/[$,\s]/g, '')
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null
  const cents = Math.round(parseFloat(s) * 100)
  return negative ? -cents : cents
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

/** Accepts 2026-01-15, 1/15/2026, 1/15, Jan 15, 15 Jan 2026 and spreadsheet serial numbers. */
export function parseDate(raw: string, defaultYear: number, allowSerial = true): string | null {
  const s = raw.trim().replace(/,/g, ' ').replace(/\s+/g, ' ')
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return iso(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/)
  if (m) return iso(m[3] ? +m[3] : defaultYear, +m[1], +m[2])
  m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/)
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
    return mi < 0 ? null : iso(m[3] ? +m[3] : defaultYear, mi + 1, +m[2])
  }
  m = s.match(/^(\d{1,2}) ([A-Za-z]{3,9})\.?(?: (\d{4}))?$/)
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase())
    return mi < 0 ? null : iso(m[3] ? +m[3] : defaultYear, mi + 1, +m[1])
  }
  if (allowSerial && /^\d{5}(\.0+)?$/.test(s)) {
    const n = parseInt(s, 10)
    if (n > 30000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10)
  }
  return null
}

/** Splits pasted text into cells. Tabs if present (spreadsheet copy), otherwise CSV with quotes. */
export function splitRows(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (text.includes('\t')) return lines.map((l) => l.split('\t').map((c) => c.trim()))
  return lines.map((line) => {
    const cells: string[] = []
    let cur = ''
    let quoted = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
        else if (ch === '"') quoted = false
        else cur += ch
      } else if (ch === '"') quoted = true
      else if (ch === ',') { cells.push(cur.trim()); cur = '' }
      else cur += ch
    }
    cells.push(cur.trim())
    return cells
  })
}

// Categories that were folded into others partway through 2026.
const CATEGORY_ALIASES: Record<string, string> = { exercise: 'subscriptions', misc: 'shopping' }

export function matchCategory(raw: string, categories: { id: number; name: string }[]): number | null {
  let key = raw.trim().toLowerCase()
  if (!key) return null
  key = CATEGORY_ALIASES[key] ?? key
  return categories.find((c) => c.name.trim().toLowerCase() === key)?.id ?? null
}

export type Role = 'date' | 'amount' | 'description' | 'category' | 'ignore' | `account:${number}`

function frac(rows: string[][], col: number, test: (cell: string) => boolean): number {
  const filled = rows.map((r) => r[col] ?? '').filter((c) => c !== '')
  return filled.length ? filled.filter(test).length / filled.length : 0
}

/** Guess what each pasted column holds from its contents. */
export function guessRoles(
  rows: string[][],
  categories: { id: number; name: string }[],
  defaultYear: number,
): Role[] {
  const width = Math.max(0, ...rows.map((r) => r.length))
  const roles: Role[] = Array(width).fill('ignore')
  const cols = [...Array(width).keys()]
  const best = (score: (c: number) => number, min: number) => {
    const free = cols.filter((c) => roles[c] === 'ignore')
    const top = free.sort((a, b) => score(b) - score(a))[0]
    return top !== undefined && score(top) >= min ? top : undefined
  }
  const date = best((c) => frac(rows, c, (x) => parseDate(x, defaultYear, false) !== null), 0.5)
  if (date !== undefined) roles[date] = 'date'
  const cat = best((c) => frac(rows, c, (x) => matchCategory(x, categories) !== null), 0.5)
  if (cat !== undefined) roles[cat] = 'category'
  const amount = best((c) => frac(rows, c, (x) => parseAmount(x) !== null), 0.5)
  if (amount !== undefined) roles[amount] = 'amount'
  const desc = cols.find((c) => roles[c] === 'ignore' && rows.some((r) => (r[c] ?? '') !== ''))
  if (desc !== undefined) roles[desc] = 'description'
  return roles
}

export interface ParsedRow {
  line: number
  date: string | null
  amount_cents: number | null
  description: string
  category_id: number | null
  balances: { account_id: number; balance_cents: number }[]
  /** Blocking: the row cannot be imported. */
  errors: string[]
  /** Non-blocking: the row imports, but something was dropped. */
  warnings: string[]
}

/**
 * Applies column roles to pasted rows. Rows with neither a date nor an amount (blank lines,
 * headers, total rows left empty) are dropped and counted, not reported as errors.
 */
export function parseRows(
  rows: string[][],
  roles: Role[],
  categories: { id: number; name: string }[],
  defaultYear: number,
): { parsed: ParsedRow[]; skipped: number } {
  const parsed: ParsedRow[] = []
  let skipped = 0
  const snapshotMode = roles.some((r) => r.startsWith('account:'))
  rows.forEach((cells, i) => {
    const row: ParsedRow = { line: i + 1, date: null, amount_cents: null, description: '', category_id: null, balances: [], errors: [], warnings: [] }
    let rawDate = ''
    let rawAmount = ''
    let rawCategory = ''
    roles.forEach((role, c) => {
      const cell = cells[c] ?? ''
      if (role === 'date') { rawDate = cell; row.date = parseDate(cell, defaultYear) }
      else if (role === 'amount') { rawAmount = cell; row.amount_cents = parseAmount(cell) }
      else if (role === 'description') row.description = cell
      else if (role === 'category') { rawCategory = cell; row.category_id = matchCategory(cell, categories) }
      else if (role.startsWith('account:') && cell !== '') {
        const cents = parseAmount(cell)
        if (cents !== null) row.balances.push({ account_id: +role.slice(8), balance_cents: cents })
      }
    })
    if (snapshotMode) {
      if (row.date === null || row.balances.length === 0) { skipped++; return }
    } else {
      if (row.date === null && row.amount_cents === null) { skipped++; return }
      if (row.date === null) row.errors.push(rawDate ? 'unreadable date' : 'missing date')
      if (row.amount_cents === null) row.errors.push(rawAmount ? 'unreadable amount' : 'missing amount')
      if (rawCategory && row.category_id === null) row.warnings.push('unknown category, imported uncategorized')
    }
    parsed.push(row)
  })
  return { parsed, skipped }
}
