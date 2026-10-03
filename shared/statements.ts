// Reading bank and card CSV exports. Each format is recognised by its header row.
import { parseAmount, parseDate, splitRows } from './parse.ts'

export type StatementFormat = 'chase-checking' | 'usbank-checking' | 'chase-card' | 'capitalone-card'

export interface StatementBankLine {
  date: string
  description: string
  /** Signed: money into the account is positive. */
  amount_cents: number
  /** The bank's own transaction type, such as LOAN_PMT. Empty when the export has none. */
  type: string
  /** The bank's running balance after this line, when the export has one (Chase does, US Bank does not). */
  balance_cents: number | null
  fingerprint: string
}

export type CardLineKind = 'charge' | 'refund' | 'payment'
export interface StatementCardLine {
  date: string
  description: string
  /** Signed as spending: a charge is positive, a refund or payment negative. */
  amount_cents: number
  kind: CardLineKind
  last4: string | null
  fingerprint: string
}

export type ParsedStatement =
  | { format: Extract<StatementFormat, `${string}-checking`>; kind: 'bank'; lines: StatementBankLine[]; skipped: number }
  | { format: Extract<StatementFormat, `${string}-card`>; kind: 'card'; lines: StatementCardLine[]; skipped: number }

export const FORMAT_NAMES: Record<StatementFormat, string> = {
  'chase-checking': 'Chase checking',
  'usbank-checking': 'US Bank checking',
  'chase-card': 'Chase credit card',
  'capitalone-card': 'Capital One credit card',
}

const HEADERS: [StatementFormat, string[]][] = [
  ['chase-checking', ['details', 'posting date', 'description', 'amount', 'type', 'balance']],
  ['chase-card', ['transaction date', 'post date', 'description', 'type', 'amount']],
  ['capitalone-card', ['transaction date', 'posted date', 'card no.', 'description', 'debit', 'credit']],
  ['usbank-checking', ['date', 'transaction', 'name', 'amount']],
]

// A Capital One credit is either a payment or a refund; payments say so in the description.
const CAPITAL_ONE_PAYMENT = /\b(PYMT|PMT|PAYMENT|AUTOPAY)\b/i

/**
 * Lines that repeat exactly within one export (two identical coffees on a day) are told apart by
 * their order, so loading an overlapping export later recognises lines already loaded.
 */
function fingerprints<T extends { date: string; description: string; amount_cents: number }>(lines: T[], extra: (l: T) => string = () => '') {
  const seen = new Map<string, number>()
  return lines.map((l) => {
    const base = [l.date, l.description.toLowerCase(), l.amount_cents, extra(l)].join('|')
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return { ...l, fingerprint: `${base}|${n}` }
  })
}

export function parseStatement(text: string): ParsedStatement | { error: string } {
  const rows = splitRows(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c !== ''))
  if (rows.length === 0) return { error: 'The file is empty.' }
  const header = rows[0].map((c) => c.trim().toLowerCase())
  const match = HEADERS.find(([, cols]) => cols.every((c) => header.includes(c)))
  if (!match) return { error: 'Not a recognised export. Expected a Chase checking, Chase card, Capital One or US Bank CSV with its header row.' }
  const format = match[0]
  const col = (row: string[], name: string) => (row[header.indexOf(name)] ?? '').trim()
  const year = new Date().getFullYear()
  let skipped = 0

  if (format === 'chase-checking' || format === 'usbank-checking') {
    const lines: Omit<StatementBankLine, 'fingerprint'>[] = []
    for (const row of rows.slice(1)) {
      const date = parseDate(col(row, format === 'chase-checking' ? 'posting date' : 'date'), year, false)
      const amount = parseAmount(col(row, 'amount'))
      if (!date || amount === null) { skipped++; continue }
      lines.push({
        date,
        description: col(row, format === 'chase-checking' ? 'description' : 'name').replace(/\s+/g, ' '),
        amount_cents: amount,
        type: format === 'chase-checking' ? col(row, 'type') : col(row, 'transaction'),
        balance_cents: format === 'chase-checking' ? parseAmount(col(row, 'balance')) : null,
      })
    }
    // Exports list the newest first; store oldest first so the running balance reads in order.
    lines.reverse()
    return { format, kind: 'bank', lines: fingerprints(lines, (l) => String(l.balance_cents ?? '')), skipped }
  }

  const lines: Omit<StatementCardLine, 'fingerprint'>[] = []
  for (const row of rows.slice(1)) {
    const date = parseDate(col(row, 'transaction date'), year, false)
    const description = col(row, 'description').replace(/\s+/g, ' ')
    let spend: number | null
    let kind: CardLineKind
    if (format === 'chase-card') {
      const amount = parseAmount(col(row, 'amount'))
      spend = amount === null ? null : -amount
      kind = col(row, 'type').toLowerCase() === 'payment' ? 'payment' : (spend ?? 0) > 0 ? 'charge' : 'refund'
    } else {
      const debit = parseAmount(col(row, 'debit'))
      const credit = parseAmount(col(row, 'credit'))
      spend = debit !== null ? debit : credit !== null ? -credit : null
      kind = debit !== null ? 'charge' : CAPITAL_ONE_PAYMENT.test(description) ? 'payment' : 'refund'
    }
    if (!date || spend === null || spend === 0) { skipped++; continue }
    lines.push({ date, description, amount_cents: spend, kind, last4: format === 'capitalone-card' ? col(row, 'card no.') || null : null })
  }
  // Card exports are ordered by posting date; the transaction date is what matters here.
  lines.reverse()
  lines.sort((a, b) => a.date.localeCompare(b.date))
  return { format, kind: 'card', lines: fingerprints(lines), skipped }
}
