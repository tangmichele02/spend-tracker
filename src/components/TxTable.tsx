import { useState } from 'react'
import { parseAmount } from '../../shared/parse.ts'
import type { Tx } from '../../shared/types.ts'
import { api } from '../api.ts'
import { useData } from '../App.tsx'
import { amountField, dateLabel, money, monthLabel } from '../format.ts'

interface Props {
  rows: Tx[]
  onChanged: () => void
  onReimburse?: (tx: Tx) => void
  withYear?: boolean
  /** Rows all belong to one account: drop the Account column and sign transfers in and out. */
  perAccount?: boolean
}

function shownAmount(tx: Tx, perAccount?: boolean): string {
  if (tx.kind === 'purchase') return money(-tx.amount_cents)
  if (tx.kind === 'transfer' && perAccount) return tx.amount_cents > 0 ? `+${money(tx.amount_cents)}` : money(tx.amount_cents)
  if (tx.kind === 'transfer') return money(Math.abs(tx.amount_cents))
  return `+${money(tx.amount_cents)}`
}

export function TxTable({ rows, onChanged, onReimburse, withYear, perAccount }: Props) {
  const { accounts, categories } = useData()
  const [editing, setEditing] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [draft, setDraft] = useState({ kind: '', date: '', month: '', description: '', amount: '', category_id: '', account_id: '', one_off: false })
  const [error, setError] = useState('')

  function startEdit(tx: Tx) {
    setEditing(tx.id)
    setError('')
    setDraft({
      kind: tx.kind, date: tx.date, month: tx.month, description: tx.description, amount: amountField(tx.amount_cents),
      category_id: tx.category_id ? String(tx.category_id) : '', account_id: String(tx.account_id), one_off: !!tx.one_off,
    })
  }

  async function save(tx: Tx) {
    const cents = parseAmount(draft.amount)
    if (cents === null || cents === 0) return setError('Enter an amount, such as 12.50')
    const body = tx.kind === 'transfer'
      ? { date: draft.date, month: draft.month, description: draft.description, amount_cents: Math.abs(cents) }
      : {
          kind: draft.kind, date: draft.date, month: draft.month, description: draft.description, amount_cents: cents, account_id: +draft.account_id,
          category_id: draft.category_id ? +draft.category_id : null, one_off: draft.kind === 'reimbursement' ? false : draft.one_off,
        }
    try {
      await api('PATCH', `/api/transactions/${tx.id}`, body)
      setEditing(null)
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove(tx: Tx) {
    await api('DELETE', `/api/transactions/${tx.id}`)
    setConfirming(null)
    onChanged()
  }

  async function toggleCleared(tx: Tx) {
    await api('PATCH', `/api/transactions/${tx.id}`, { cleared: !tx.cleared })
    onChanged()
  }

  // Money arriving in a checking account from another of your accounts: a Zelle between checking
  // accounts, or a withdrawal from savings or investments.
  const isChecking = (name: string | null) => accounts.some((a) => a.name === name && a.type === 'checking')
  const internal = (tx: Tx) => tx.other_account_name !== null && isChecking(tx.amount_cents > 0 ? tx.account_name : tx.other_account_name)

  if (rows.length === 0) return <p className="muted empty">Nothing here yet.</p>
  const onKey = (tx: Tx) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void save(tx)
    if (e.key === 'Escape') setEditing(null)
  }

  return (
    <div className="table-wrap">
      <table className="tx">
        <thead>
          <tr>
            <th className="tick" title="Tick when this line matches your bank statement">✓</th>
            <th>Date</th><th>Description</th><th>Category</th>{!perAccount && <th>Account</th>}<th className="num">Amount</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((tx) => editing === tx.id ? (
            <tr key={tx.id} className="editing" onKeyDown={onKey(tx)}>
              <td />
              <td>
                <input type="date" value={draft.date} aria-label="Date" onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
                <label className="check small">Counts in<input type="month" value={draft.month} onChange={(e) => setDraft({ ...draft, month: e.target.value })} /></label>
              </td>
              <td>
                <input autoFocus value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                {tx.kind !== 'transfer' && (
                  <label className="check small">Type
                    <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                      <option value="purchase">Purchase</option>
                      <option value="income">Income</option>
                      <option value="reimbursement">Reimbursement</option>
                    </select>
                  </label>
                )}
                {error && <div className="error">{error}</div>}
              </td>
              <td>
                {draft.kind === 'purchase' || (draft.kind === 'reimbursement' && !tx.reimburses_id) ? (
                  <>
                    <select value={draft.category_id} onChange={(e) => setDraft({ ...draft, category_id: e.target.value })}>
                      <option value="">None</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    {draft.kind === 'purchase' && (
                      <label className="check small"><input type="checkbox" checked={draft.one_off} onChange={(e) => setDraft({ ...draft, one_off: e.target.checked })} />One-off</label>
                    )}
                  </>
                ) : draft.kind === 'income' ? (
                  <label className="check small"><input type="checkbox" checked={draft.one_off} onChange={(e) => setDraft({ ...draft, one_off: e.target.checked })} />One-off</label>
                ) : null}
              </td>
              {!perAccount && <td>
                {tx.kind === 'transfer' ? tx.account_name : (
                  <select value={draft.account_id} onChange={(e) => setDraft({ ...draft, account_id: e.target.value })}>
                    {accounts.filter((a) => a.type === 'checking' || a.id === tx.account_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                )}
              </td>}
              <td className="num"><input className="num" inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></td>
              <td className="actions">
                <button type="button" className="primary" onClick={() => void save(tx)}>Save</button>
                <button type="button" onClick={() => setEditing(null)}>Cancel</button>
              </td>
            </tr>
          ) : (
            <tr key={tx.id}>
              <td className="tick"><input type="checkbox" checked={!!tx.cleared} onChange={() => void toggleCleared(tx)} aria-label="Matches statement" /></td>
              <td className="nowrap">{dateLabel(tx.date, withYear)}</td>
              <td>
                {tx.kind === 'transfer'
                  ? <>{tx.amount_cents < 0 || !tx.other_account_name ? '' : '← '}{tx.description || (internal(tx) ? '' : 'Transfer')}</>
                  : tx.description || <span className="muted">(no description)</span>}
                {tx.kind === 'income' && <span className="tag income">income</span>}
                {tx.kind === 'transfer' && (
                  <span className={internal(tx) ? 'tag internal' : 'tag transfer'}>
                    {internal(tx) && 'internal transfer '}
                    {tx.other_account_name
                      ? tx.amount_cents < 0 ? `to ${tx.other_account_name}` : `from ${tx.other_account_name}`
                      : 'from paycheck'}
                  </span>
                )}
                {tx.kind === 'reimbursement' && (
                  <span className="tag reimbursement">
                    {tx.reimburses_id ? `reimburses ${tx.reimburses_description || 'purchase'}, ${dateLabel(tx.reimburses_date!, true)}` : 'reimbursement'}
                  </span>
                )}
                {!!tx.one_off && <span className="tag oneoff">one-off</span>}
                {withYear && tx.month !== tx.date.slice(0, 7) && <span className="tag">counts in {monthLabel(tx.month, 'short')} {tx.month.slice(0, 4)}</span>}
                {tx.reimbursed_cents > 0 && <span className="tag reimbursement">{money(tx.reimbursed_cents)} reimbursed</span>}
              </td>
              <td>{tx.category_name && <span className="cat" style={{ background: tx.category_color ?? undefined }}>{tx.category_name}</span>}</td>
              {!perAccount && <td className="nowrap">{tx.account_name}</td>}
              <td className={`num nowrap${tx.kind === 'income' || tx.kind === 'reimbursement' ? ' inflow' : ''}`}>{shownAmount(tx, perAccount)}</td>
              <td className="actions">
                {confirming === tx.id ? (
                  <>
                    <button type="button" className="danger" onClick={() => void remove(tx)}>Delete</button>
                    <button type="button" onClick={() => setConfirming(null)}>Keep</button>
                  </>
                ) : (
                  <>
                    {onReimburse && tx.kind === 'purchase' && <button type="button" onClick={() => onReimburse(tx)}>Reimburse</button>}
                    <button type="button" onClick={() => startEdit(tx)}>Edit</button>
                    <button type="button" aria-label="Delete" onClick={() => setConfirming(tx.id)}>×</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
