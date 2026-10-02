import { useEffect, useState } from 'react'
import type { Tx } from '../../shared/types.ts'
import { api, query } from '../api.ts'
import { useData } from '../App.tsx'
import { TxTable } from '../components/TxTable.tsx'

const PAGE = 200

const KINDS = ['purchase', 'income', 'reimbursement', 'transfer']

export function Transactions({ kind }: { kind?: string }) {
  const { accounts, categories } = useData()
  const [filters, setFilters] = useState({ q: '', from: '', to: '', account: '', category: '', kind: kind && KINDS.includes(kind) ? kind : '', one_off: '' })
  const [rows, setRows] = useState<Tx[]>([])
  const [more, setMore] = useState(false)
  const [version, setVersion] = useState(0)
  const [shown, setShown] = useState(PAGE)

  useEffect(() => {
    let stale = false
    const timer = setTimeout(() => {
      void api<{ rows: Tx[]; more: boolean }>('GET', `/api/transactions${query({ ...filters, limit: shown })}`).then((r) => {
        if (stale) return
        setRows(r.rows)
        setMore(r.more)
      })
    }, 150)
    return () => { stale = true; clearTimeout(timer) }
  }, [filters, version, shown])

  const set = (key: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setShown(PAGE)
    setFilters({ ...filters, [key]: e.target.value })
  }
  return (
    <>
      <div className="heading"><h1>Transactions</h1></div>
      <div className="card filters">
        <label className="grow">Search<input value={filters.q} onChange={set('q')} placeholder="Description" /></label>
        <label>From<input type="date" value={filters.from} onChange={set('from')} /></label>
        <label>To<input type="date" value={filters.to} onChange={set('to')} /></label>
        <label>Account
          <select value={filters.account} onChange={set('account')}>
            <option value="">All</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label>Category
          <select value={filters.category} onChange={set('category')}>
            <option value="">All</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="none">Uncategorized</option>
          </select>
        </label>
        <label>Type
          <select value={filters.kind} onChange={set('kind')}>
            <option value="">All</option>
            <option value="purchase">Purchases</option>
            <option value="income">Income</option>
            <option value="reimbursement">Reimbursements</option>
            <option value="transfer">Transfers</option>
          </select>
        </label>
        <label>One-off
          <select value={filters.one_off} onChange={set('one_off')}>
            <option value="">All</option>
            <option value="1">One-off only</option>
          </select>
        </label>
      </div>
      <section className="card">
        <TxTable rows={rows} onChanged={() => setVersion(version + 1)} withYear />
        {more && <button type="button" className="more" onClick={() => setShown(shown + PAGE)}>Show {PAGE} more</button>}
      </section>
    </>
  )
}
