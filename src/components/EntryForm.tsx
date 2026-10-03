import { useEffect, useRef, useState } from 'react'
import { parseAmount } from '../../shared/parse.ts'
import type { Kind, Tx } from '../../shared/types.ts'
import { api, query } from '../api.ts'
import { useData } from '../App.tsx'
import { amountField, dateLabel, money, monthLabel } from '../format.ts'
import { store, stored } from '../hooks.ts'
import { QuickGrid } from './QuickGrid.tsx'

type Mode = Kind | 'entries'
const KINDS: [Mode, string][] = [
  ['entries', 'Entries'],
  ['reimbursement', 'Linked reimbursement'],
  ['transfer', 'Transfer'],
]

interface Props {
  /** Month new entries are filed under, whatever date they carry. */
  month: string
  defaultDate: string
  onSaved: () => void
  /** A purchase the user clicked "reimburse" on. */
  reimburse: Tx | null
  onReimburseHandled: () => void
}

export function EntryForm({ month, defaultDate, onSaved, reimburse, onReimburseHandled }: Props) {
  const { accounts, categories, descriptions, reload } = useData()
  const active = accounts.filter((a) => !a.archived)
  const checking = active.filter((a) => a.type === 'checking')

  const [kind, setKind] = useState<Mode>('entries')
  const [date, setDate] = useState(defaultDate)
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [oneOff, setOneOff] = useState(false)
  const [accountId, setAccountId] = useState(() => {
    const remembered = stored('account:purchase')
    return checking.some((a) => String(a.id) === remembered) ? remembered! : String(checking[0]?.id ?? '')
  })
  const [fromId, setFromId] = useState(String(checking[0]?.id ?? ''))
  const [toId, setToId] = useState('')
  const [linked, setLinked] = useState<Tx | null>(null)
  const [search, setSearch] = useState('')
  const [matches, setMatches] = useState<Tx[]>([])
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const first = useRef<HTMLInputElement>(null)

  useEffect(() => setDate(defaultDate), [defaultDate])

  function switchKind(next: Mode) {
    setKind(next)
    setError('')
    setLinked(null)
    if (next !== 'transfer' && next !== 'entries') {
      const remembered = stored(`account:${next}`)
      setAccountId(checking.some((a) => String(a.id) === remembered) ? remembered! : String(checking[0]?.id ?? ''))
    }
  }

  useEffect(() => {
    if (!reimburse) return
    setKind('reimbursement')
    setLinked(reimburse)
    setAmount(amountField(reimburse.amount_cents + reimburse.reimbursed_cents))
    setDescription(`Refund: ${reimburse.description}`)
    setAccountId(String(reimburse.account_id))
    onReimburseHandled()
    first.current?.focus()
  }, [reimburse, onReimburseHandled])

  // Search purchases to link a reimbursement to.
  useEffect(() => {
    if (kind !== 'reimbursement' || linked || search.trim().length < 2) { setMatches([]); return }
    let stale = false
    void api<{ rows: Tx[] }>('GET', `/api/transactions${query({ kind: 'purchase', q: search.trim(), limit: 8 })}`)
      .then((r) => { if (!stale) setMatches(r.rows) })
      .catch(() => {})
    return () => { stale = true }
  }, [kind, linked, search])

  function onDescription(value: string) {
    setDescription(value)
    if (kind !== 'purchase') return
    // A description used before brings its last category with it.
    const known = descriptions.find((d) => d.description.toLowerCase() === value.trim().toLowerCase())
    if (known?.category_id) setCategoryId(String(known.category_id))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaved('')
    const cents = parseAmount(amount)
    if (cents === null || cents === 0) return setError('Enter an amount, such as 12.50')
    try {
      if (kind === 'transfer') {
        if (!toId) return setError('Choose where the money went')
        await api('POST', '/api/transfers', {
          date, month, from_account_id: fromId ? +fromId : null, to_account_id: +toId, amount_cents: Math.abs(cents), description,
        })
      } else {
        await api('POST', '/api/transactions', {
          kind, date, month, account_id: +accountId, amount_cents: cents, description,
          category_id: categoryId && !linked ? +categoryId : null,
          one_off: oneOff, reimburses_id: linked?.id ?? null,
        })
        store(`account:${kind}`, accountId)
      }
      setError('')
      setSaved(`Saved ${money(Math.abs(cents))}${description ? ` · ${description}` : ''}`)
      setAmount('')
      setDescription('')
      setOneOff(false)
      setLinked(null)
      setSearch('')
      if (kind !== 'purchase') setCategoryId('')
      onSaved()
      void reload()
      first.current?.focus()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const tabs = (
    <div className="tabs" role="tablist">
      {KINDS.map(([k, label]) => (
        <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => switchKind(k)}>
          {label}
        </button>
      ))}
    </div>
  )
  const datalist = (
    <datalist id="known-descriptions">
      {descriptions.slice(0, 500).map((d) => <option key={d.description} value={d.description} />)}
    </datalist>
  )
  if (kind === 'entries') {
    return (
      <div className="card entry">
        {tabs}
        <QuickGrid month={month} defaultDate={defaultDate} onSaved={onSaved} />
        {datalist}
      </div>
    )
  }

  return (
    <form className="card entry" onSubmit={submit}>
      <div className="tabs" role="tablist">
        {KINDS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => switchKind(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="fields">
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
        <label className="grow">
          {kind === 'income' ? 'Source' : kind === 'transfer' ? 'Note' : 'Description'}
          <input ref={first} list={kind === 'purchase' ? 'known-descriptions' : undefined} value={description}
            onChange={(e) => onDescription(e.target.value)} placeholder={kind === 'transfer' ? 'Optional' : ''} />
        </label>
        <label>Amount<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="num" /></label>
        {kind === 'transfer' ? (
          <>
            <label>From
              <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                {active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                <option value="">Paycheck (never in checking)</option>
              </select>
            </label>
            <label>To
              <select value={toId} onChange={(e) => setToId(e.target.value)}>
                <option value="">Choose…</option>
                {active.filter((a) => String(a.id) !== fromId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          </>
        ) : (
          <label>{kind === 'purchase' ? 'Paid from' : 'Into'}
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {checking.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
        {(kind === 'purchase' || (kind === 'reimbursement' && !linked)) && (
          <label>Category
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">None</option>
              {categories.filter((c) => !c.archived).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        {(kind === 'purchase' || kind === 'income') && (
          <label className="check" title={kind === 'income' ? 'A tax refund, bonus or gift: kept out of regular income' : 'Kept out of regular spending'}><input type="checkbox" checked={oneOff} onChange={(e) => setOneOff(e.target.checked)} />One-off</label>
        )}
        <button className="primary" type="submit">Add</button>
      </div>
      {kind === 'reimbursement' && (
        <div className="link-row">
          {linked ? (
            <span className="chip">
              For {linked.description || 'purchase'} · {dateLabel(linked.date, true)} · {money(-linked.amount_cents)}
              <button type="button" aria-label="Remove link" onClick={() => setLinked(null)}>×</button>
            </span>
          ) : (
            <div className="picker">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Link to a purchase (optional): type to search" />
              {matches.length > 0 && (
                <ul>
                  {matches.map((m) => (
                    <li key={m.id}>
                      <button type="button" onClick={() => { setLinked(m); setMatches([]); setSearch('') }}>
                        <span>{m.description}</span>
                        <span className="muted">{dateLabel(m.date, true)} · {money(-m.amount_cents)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <span className="muted">
            {linked ? 'Counts against the month and category of that purchase.' : 'Unlinked, it lowers its category in the month it arrives.'}
          </span>
        </div>
      )}
      {kind === 'transfer' && <p className="muted hint">Moves into savings or investments, and Zelle between checking accounts. Never counted as spending.</p>}
      {date.slice(0, 7) !== month && date && (
        <p className="muted hint">Dated {dateLabel(date, true)}, but it will count in {monthLabel(month)}, the month you are viewing.</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {saved && !error && <p className="muted hint" role="status">{saved}</p>}
      <datalist id="known-descriptions">
        {descriptions.slice(0, 500).map((d) => <option key={d.description} value={d.description} />)}
      </datalist>
    </form>
  )
}
