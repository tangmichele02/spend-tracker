import { Fragment, useState } from 'react'
import type { MerchantGroup, MerchantRule } from '../../shared/types.ts'
import { api, query } from '../api.ts'
import { dateLabel, money } from '../format.ts'
import { useLoad } from '../hooks.ts'

export function Companies() {
  const year = new Date().getFullYear()
  const [from, setFrom] = useState(`${year}-01-01`)
  const [to, setTo] = useState(`${year}-12-31`)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const groups = useLoad<MerchantGroup[]>(`/api/merchants${query({ from, to })}`)
  const rules = useLoad<MerchantRule[]>('/api/rules')
  const [rule, setRule] = useState({ pattern: '', merchant: '', is_regex: false })
  const [error, setError] = useState('')

  async function addRule(e: React.FormEvent) {
    e.preventDefault()
    try {
      await api('POST', '/api/rules', { ...rule, is_regex: rule.is_regex ? 1 : 0 })
      setRule({ pattern: '', merchant: '', is_regex: false })
      setError('')
      void rules.reload()
      void groups.reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const shown = (groups.data ?? []).filter((g) => g.merchant.toLowerCase().includes(filter.trim().toLowerCase()))
  return (
    <>
      <div className="heading"><h1>Companies</h1></div>
      <div className="card filters">
        <label className="grow">Search<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Company" /></label>
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="split">
        <section className="card">
          <h2>Purchases by company</h2>
          {shown.length === 0 ? <p className="muted empty">No purchases in this range.</p> : (
            <div className="table-wrap">
              <table className="tx">
                <thead><tr><th>Company</th><th className="num">Purchases</th><th className="num">Total</th><th>First</th><th>Last</th><th /></tr></thead>
                <tbody>
                  {shown.map((g) => (
                    <Fragment key={g.merchant}>
                      <tr>
                        <td>
                          <button type="button" className="linkish" aria-expanded={open === g.merchant} onClick={() => setOpen(open === g.merchant ? null : g.merchant)}>
                            {open === g.merchant ? '▾' : '▸'} {g.merchant}
                          </button>
                        </td>
                        <td className="num">{g.count}</td>
                        <td className="num">{money(g.cents)}</td>
                        <td className="nowrap">{dateLabel(g.first, true)}</td>
                        <td className="nowrap">{dateLabel(g.last, true)}</td>
                        <td className="actions">
                          {!g.matched_rule && <button type="button" onClick={() => setRule({ pattern: g.merchant, merchant: g.merchant, is_regex: false })}>Make rule</button>}
                        </td>
                      </tr>
                      {open === g.merchant && g.items.map((item) => (
                        <tr key={item.id} className="sub">
                          <td>{item.description}{item.cents < 0 && <span className="tag reimbursement">refund</span>}</td>
                          <td className="muted">{item.category_name ?? ''}</td>
                          <td className="num">{money(item.cents)}</td>
                          <td className="nowrap" colSpan={3}>{dateLabel(item.date, true)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <aside>
          <section className="card">
            <h2>Grouping rules</h2>
            <p className="muted small">
              Any purchase whose description contains the text is filed under the company. Rules apply to past entries too, and the first match wins.
              Without a rule, purchases group by the description you typed.
            </p>
            <form className="stack" onSubmit={addRule}>
              <label>Description contains<input value={rule.pattern} onChange={(e) => setRule({ ...rule, pattern: e.target.value })} placeholder={rule.is_regex ? 'amzn|amazon' : 'amzn'} /></label>
              <label>Company<input value={rule.merchant} onChange={(e) => setRule({ ...rule, merchant: e.target.value })} placeholder="Amazon" /></label>
              <label className="check"><input type="checkbox" checked={rule.is_regex} onChange={(e) => setRule({ ...rule, is_regex: e.target.checked })} />Treat as a regular expression</label>
              <button className="primary" type="submit">Add rule</button>
              {error && <p className="error">{error}</p>}
            </form>
            <ul className="rules">
              {rules.data?.map((r) => (
                <li key={r.id}>
                  <span><code>{r.pattern}</code>{r.is_regex ? <span className="tag">regex</span> : null} → {r.merchant}</span>
                  <button type="button" aria-label={`Delete rule for ${r.merchant}`} onClick={() => void api('DELETE', `/api/rules/${r.id}`).then(() => { void rules.reload(); void groups.reload() })}>×</button>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </>
  )
}
