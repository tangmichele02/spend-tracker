import { useEffect, useRef, useState } from 'react'
import { matchCategory, parseAmount, parseDate } from '../../shared/parse.ts'
import type { Category } from '../../shared/types.ts'
import { api } from '../api.ts'
import { useData } from '../App.tsx'
import { money } from '../format.ts'
import { store, stored } from '../hooks.ts'

type RowKind = 'purchase' | 'income' | 'reimbursement'
interface Row {
  key: number
  kind: RowKind
  date: string
  description: string
  amount: string
  category: string
  accountId: string
  oneOff: boolean
  error: string
}
// Columns that arrow keys move between, in order.
const COLS = ['date', 'description', 'amount', 'category'] as const
type Col = (typeof COLS)[number]

/** "15" is the 15th of the month being viewed; anything else goes through the usual date parser. */
function resolveDate(text: string, month: string): string | null {
  const t = text.trim()
  if (/^\d{1,2}$/.test(t)) {
    const iso = `${month}-${t.padStart(2, '0')}`
    return parseDate(iso, +month.slice(0, 4))
  }
  return parseDate(t, +month.slice(0, 4))
}

/** Exact name or alias first, then the first category starting with what was typed ("gro" is Groceries). */
function resolveCategory(text: string, categories: Category[]): Category | null {
  const t = text.trim().toLowerCase()
  if (!t) return null
  const active = categories.filter((c) => !c.archived)
  const exact = matchCategory(t, active)
  return active.find((c) => c.id === exact) ?? active.find((c) => c.name.toLowerCase().startsWith(t)) ?? null
}

const shortDate = (iso: string) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`

let nextKey = 1

/**
 * Spreadsheet-style entry: type across a row, press Enter to save it and land on a fresh row below.
 * The date and account carry down from the row above, as they usually repeat.
 */
export function QuickGrid({ month, defaultDate, onSaved }: { month: string; defaultDate: string; onSaved: () => void }) {
  const { accounts, categories, descriptions, reload } = useData()
  const checking = accounts.filter((a) => !a.archived && a.type === 'checking')
  const remembered = stored('account:purchase')
  const startAccount = checking.some((a) => String(a.id) === remembered) ? remembered! : String(checking[0]?.id ?? '')

  const blank = (from?: Row): Row => ({
    key: nextKey++, kind: 'purchase', date: from?.date ?? '', description: '', amount: '', category: '',
    accountId: from?.accountId ?? startAccount, oneOff: false, error: '',
  })
  const [rows, setRows] = useState<Row[]>(() => [blank()])
  // Saving is async, so read the rows as they are when the save finishes, not when it started.
  const latest = useRef(rows)
  latest.current = rows
  const [savedCount, setSavedCount] = useState(0)
  const [lastSaved, setLastSaved] = useState('')
  const cells = useRef(new Map<string, HTMLInputElement | HTMLSelectElement>())
  const [focusNext, setFocusNext] = useState<{ key: number; col: Col } | null>(null)

  // A new month starts a clean sheet.
  useEffect(() => { setRows([blank()]); setSavedCount(0); setLastSaved('') }, [month]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!focusNext) return
    const el = cells.current.get(`${focusNext.key}:${focusNext.col}`)
    if (el) { el.focus(); if (el instanceof HTMLInputElement) el.select() }
    setFocusNext(null)
  }, [focusNext, rows])

  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch, error: patch.error ?? '' } : r)))
  const isEmpty = (r: Row) => !r.description.trim() && !r.amount.trim() && !r.category.trim()

  function onDescription(row: Row, value: string) {
    const patch: Partial<Row> = { description: value }
    // A description used before brings its last category with it.
    const known = descriptions.find((d) => d.description.toLowerCase() === value.trim().toLowerCase())
    if (known?.category_id && row.kind !== 'income' && !row.category) {
      patch.category = categories.find((c) => c.id === known.category_id)?.name ?? ''
    }
    update(row.key, patch)
  }

  async function commit(row: Row): Promise<boolean> {
    if (isEmpty(row)) return true
    const date = row.date.trim() ? resolveDate(row.date, month) : defaultDate
    const cents = parseAmount(row.amount)
    const category = row.kind === 'income' ? null : resolveCategory(row.category, categories)
    const problem = !date ? 'Date not recognised (try 15 or 1/15)'
      : cents === null || cents === 0 ? 'Amount needed'
      : row.category.trim() && row.kind !== 'income' && !category ? `No category starting "${row.category.trim()}"`
      : ''
    if (problem) { update(row.key, { error: problem }); return false }
    try {
      await api('POST', '/api/transactions', {
        kind: row.kind, date, month, account_id: +row.accountId, amount_cents: cents, description: row.description,
        category_id: category?.id ?? null, one_off: row.oneOff,
      })
    } catch (e) {
      update(row.key, { error: (e as Error).message })
      return false
    }
    store('account:purchase', row.accountId)
    setSavedCount((n) => n + 1)
    setLastSaved(`${money(Math.abs(cents!))}${row.description ? ` · ${row.description}` : ''}`)
    return true
  }

  /** Saves a row; on success it leaves the grid and the cursor lands on the empty row at the bottom. */
  async function enter(row: Row) {
    if (isEmpty(row)) return
    if (!(await commit(row))) return
    const rest = latest.current.filter((r) => r.key !== row.key)
    const last = rest.at(-1)
    const tail = last && isEmpty(last) ? { ...last, date: last.date || row.date, accountId: row.accountId } : blank(row)
    setRows([...rest.filter((r) => r.key !== tail.key), tail])
    setFocusNext({ key: tail.key, col: row.date.trim() ? 'description' : 'date' })
    onSaved()
    void reload()
  }

  async function saveAll() {
    const pending = rows.filter((r) => !isEmpty(r))
    const done = new Set<number>()
    for (const r of pending) if (await commit(r)) done.add(r.key)
    const left = latest.current.filter((r) => !done.has(r.key))
    setRows(left.some(isEmpty) ? left : [...left, blank(latest.current.at(-1))])
    if (done.size) { onSaved(); void reload() }
  }

  function onKeyDown(row: Row, col: Col | 'kind' | 'account' | 'oneoff') {
    return (e: React.KeyboardEvent) => {
      const i = rows.findIndex((r) => r.key === row.key)
      if (e.key === 'Enter') { e.preventDefault(); void enter(row) }
      else if (e.key === 'Escape') update(row.key, { description: '', amount: '', category: '', oneOff: false })
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (COLS as readonly string[]).includes(col)) {
        const target = rows[i + (e.key === 'ArrowDown' ? 1 : -1)]
        if (target) { e.preventDefault(); setFocusNext({ key: target.key, col: col as Col }) }
      }
    }
  }
  const ref = (key: number, col: Col) => (el: HTMLInputElement | null) => {
    if (el) cells.current.set(`${key}:${col}`, el)
    else cells.current.delete(`${key}:${col}`)
  }

  return (
    <div className="quick">
      <div className="table-wrap">
        <table className="grid quick-grid">
          <thead>
            <tr><th>Type</th><th>Date</th><th>Description</th><th className="num">Amount</th><th>Category</th><th>Paid from / into</th><th>One-off</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const resolved = row.date.trim() ? resolveDate(row.date, month) : null
              const cat = row.kind === 'income' ? null : resolveCategory(row.category, categories)
              return (
                <tr key={row.key} className={row.error ? 'bad' : ''}>
                  <td>
                    <select value={row.kind} aria-label="Type" onKeyDown={onKeyDown(row, 'kind')}
                      onChange={(e) => update(row.key, { kind: e.target.value as RowKind, category: e.target.value === 'income' ? '' : row.category })}>
                      <option value="purchase">Purchase</option>
                      <option value="income">Income</option>
                      <option value="reimbursement">Reimbursement</option>
                    </select>
                  </td>
                  <td>
                    <input ref={ref(row.key, 'date')} value={row.date} aria-label="Date" className="date-cell"
                      placeholder={shortDate(defaultDate)} onKeyDown={onKeyDown(row, 'date')}
                      onChange={(e) => update(row.key, { date: e.target.value })}
                      onBlur={() => resolved && update(row.key, { date: shortDate(resolved) })} />
                  </td>
                  <td>
                    <input ref={ref(row.key, 'description')} value={row.description} aria-label="Description" list="known-descriptions"
                      onKeyDown={onKeyDown(row, 'description')} onChange={(e) => onDescription(row, e.target.value)} />
                    {row.error && <div className="error small">{row.error}</div>}
                  </td>
                  <td>
                    <input ref={ref(row.key, 'amount')} value={row.amount} aria-label="Amount" inputMode="decimal" className="num" placeholder="0.00"
                      onKeyDown={onKeyDown(row, 'amount')} onChange={(e) => update(row.key, { amount: e.target.value })} />
                  </td>
                  <td>
                    {row.kind !== 'income' && (
                      <input ref={ref(row.key, 'category')} value={row.category} aria-label="Category" list="category-names"
                        placeholder="Type a few letters" onKeyDown={onKeyDown(row, 'category')}
                        onChange={(e) => update(row.key, { category: e.target.value })}
                        onBlur={() => cat && update(row.key, { category: cat.name })}
                        style={cat ? { background: cat.color } : undefined} />
                    )}
                  </td>
                  <td>
                    <select value={row.accountId} aria-label="Account" onKeyDown={onKeyDown(row, 'account')} onChange={(e) => update(row.key, { accountId: e.target.value })}>
                      {checking.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </td>
                  <td className="center">
                    {row.kind !== 'reimbursement' && (
                      <input type="checkbox" aria-label="One-off" checked={row.oneOff} onKeyDown={onKeyDown(row, 'oneoff')} onChange={(e) => update(row.key, { oneOff: e.target.checked })} />
                    )}
                  </td>
                  <td className="actions">
                    {!isEmpty(row) && <button type="button" aria-label="Clear row" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== row.key) : [blank()]))}>×</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="row quick-foot">
        <span className="muted small">
          Tab moves across, <kbd>Enter</kbd> saves the row and starts the next, ↑ ↓ move between rows, <kbd>Esc</kbd> clears a row.
          Date: type <kbd>15</kbd> for the 15th; left blank it is {shortDate(defaultDate)}. Category: a few letters is enough.
        </span>
        <span className="row">
          {savedCount > 0 && <span className="muted small" role="status">Saved {savedCount} · last: {lastSaved}</span>}
          {rows.filter((r) => !isEmpty(r)).length > 1 && <button type="button" onClick={() => void saveAll()}>Save all rows</button>}
        </span>
      </div>
      <datalist id="category-names">
        {categories.filter((c) => !c.archived).map((c) => <option key={c.id} value={c.name} />)}
      </datalist>
    </div>
  )
}
