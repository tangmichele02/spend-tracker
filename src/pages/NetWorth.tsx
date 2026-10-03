import { useState } from 'react'
import { parseAmount } from '../../shared/parse.ts'
import type { NetWorth } from '../../shared/types.ts'
import { api, query } from '../api.ts'
import { Lines } from '../charts.tsx'
import { amountField, dateLabel, money, moneyWhole, today } from '../format.ts'
import { useLoad } from '../hooks.ts'

export function NetWorthPage() {
  const { data, reload } = useLoad<NetWorth>('/api/networth')
  const [date, setDate] = useState(today())
  const [values, setValues] = useState<Record<number, string>>({})
  const [error, setError] = useState('')
  if (!data) return null

  const dates = [...new Set(data.snapshots.map((s) => s.date))].sort().reverse()
  const at = (d: string, accountId: number) => data.snapshots.find((s) => s.date === d && s.account_id === accountId)
  const latest = data.series.at(-1)
  const totals = new Map(data.series.map((p) => [p.date, p]))

  async function saveBalances(e: React.FormEvent) {
    e.preventDefault()
    const rows = []
    for (const [id, raw] of Object.entries(values)) {
      if (!raw.trim()) continue
      const cents = parseAmount(raw)
      if (cents === null) return setError(`"${raw}" is not an amount`)
      rows.push({ account_id: +id, date, balance_cents: cents })
    }
    if (rows.length === 0) return setError('Enter at least one balance')
    await api('POST', '/api/snapshots', { rows })
    setError('')
    setValues({})
    void reload()
  }

  function editRow(d: string) {
    setDate(d)
    setValues(Object.fromEntries(data!.accounts.map((a) => [a.id, at(d, a.id) ? amountField(at(d, a.id)!.balance_cents) : ''])))
  }



  return (
    <>
      <div className="heading"><h1>Net worth</h1><a className="button push" href="#/import/balances">Paste balances</a></div>
      {latest && (
        <div className="tiles">
          <div className="tile"><span>Total</span><strong>{money(latest.total)}</strong><em>as of {dateLabel(latest.date, true)}</em></div>
          <div className="tile"><span>Excluding retirement</span><strong>{money(latest.non_retirement)}</strong></div>
        </div>
      )}
      <section className="card">
        <h2>Over time</h2>
        {data.series.length > 0 ? (
          <Lines label="Net worth over time" dates={data.series.map((p) => p.date)} series={[
            { name: 'Total', key: '--series-1', values: data.series.map((p) => p.total) },
            { name: 'Excluding retirement', key: '--series-2', values: data.series.map((p) => p.non_retirement) },
          ]} />
        ) : <p className="muted empty">Record balances below to start the chart.</p>}
      </section>


      <section className="card">
        <h2>Balances</h2>
        <p className="muted small">Record what each account holds on a date. Accounts you leave blank keep their last balance in the totals. To paste a whole table from your spreadsheet, use <a href="#/import/balances">Paste balances</a>.</p>
        <form onSubmit={saveBalances}>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Date</th>{data.accounts.map((a) => <th key={a.id} className="num">{a.name}</th>)}<th className="num total-col">Total</th><th className="num total-col">Excl. retirement</th><th /></tr></thead>
              <tbody>
                <tr className="editing">
                  <td><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></td>
                  {data.accounts.map((a) => (
                    <td key={a.id}><input className="num" inputMode="decimal" aria-label={a.name} value={values[a.id] ?? ''} onChange={(e) => setValues({ ...values, [a.id]: e.target.value })} /></td>
                  ))}
                  <td className="total-col" /><td className="total-col" />
                  <td className="actions"><button className="primary" type="submit">Save</button></td>
                </tr>
                {dates.map((d) => (
                  <tr key={d}>
                    <td className="nowrap">{dateLabel(d, true)}</td>
                    {data.accounts.map((a) => <td key={a.id} className="num">{at(d, a.id) ? moneyWhole(at(d, a.id)!.balance_cents) : <span className="muted">–</span>}</td>)}
                    {/* Worked out, not typed: blank accounts count at their last balance, as in the chart. */}
                    <td className="num total-col strong">{moneyWhole(totals.get(d)?.total ?? 0)}</td>
                    <td className="num total-col">{moneyWhole(totals.get(d)?.non_retirement ?? 0)}</td>
                    <td className="actions">
                      <button type="button" onClick={() => editRow(d)}>Edit</button>
                      <button type="button" aria-label={`Delete balances for ${d}`} onClick={() => void api('DELETE', `/api/snapshots${query({ date: d })}`).then(reload)}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <p className="error">{error}</p>}
        </form>
      </section>
    </>
  )
}
