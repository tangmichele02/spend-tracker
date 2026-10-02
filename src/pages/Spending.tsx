import { useState } from 'react'
import type { YearSummary } from '../../shared/types.ts'
import { BarList, Columns } from '../charts.tsx'
import { MIN_YEAR, money, moneyWhole, monthLabel, percent } from '../format.ts'
import { useLoad } from '../hooks.ts'

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

export function YearPicker({ year, setYear }: { year: number; setYear: (y: number) => void }) {
  return (
    <>
      <button type="button" onClick={() => setYear(year - 1)} disabled={year <= MIN_YEAR} aria-label="Previous year">‹</button>
      <h1>{year}</h1>
      <button type="button" onClick={() => setYear(year + 1)} aria-label="Next year">›</button>
    </>
  )
}

export function Spending() {
  const [year, setYear] = useState(new Date().getFullYear())
  const { data } = useLoad<YearSummary>(`/api/year/${year}`)
  if (!data || data.year !== year) return <div className="heading"><YearPicker year={year} setYear={setYear} /></div>

  const totals = data.months.map((_, i) => sum(data.categories.map((c) => c.cents[i])))
  const yearSpend = sum(totals)
  const yearIncome = sum(data.income)
  const cell = (cents: number) => (cents === 0 ? <span className="muted">–</span> : moneyWhole(cents))
  return (
    <>
      <div className="heading"><YearPicker year={year} setYear={setYear} /><span className="muted">Spending</span></div>
      <div className="tiles">
        <div className="tile"><span>Spending this year</span><strong>{money(yearSpend)}</strong><em>{percent(yearSpend, yearIncome)} of income</em></div>
        <div className="tile"><span>Income this year</span><strong>{money(yearIncome)}</strong>{sum(data.one_off_income) !== 0 && <em>plus {money(sum(data.one_off_income))} one-off</em>}</div>
        {sum(data.one_off) !== 0 && <div className="tile"><span>One-off spending</span><strong>{money(sum(data.one_off))}</strong><em>not in spending</em></div>}
      </div>
      <div className="split even">
        <section className="card">
          <h2>Spending by month</h2>
          <Columns label="Spending" data={data.months.map((m, i) => ({ label: monthLabel(m, 'short'), cents: totals[i] }))} />
        </section>
        <section className="card">
          <h2>Spending by category</h2>
          <BarList rows={data.categories.map((c) => ({ label: c.name, cents: sum(c.cents), color: c.color })).filter((r) => r.cents !== 0).sort((a, b) => b.cents - a.cents)} />
          {yearSpend === 0 && <p className="muted empty">No spending recorded in {year}.</p>}
        </section>
      </div>
      <section className="card">
        <h2>By category and month</h2>
        <p className="muted small">A purchase counts in the month it was made. A linked reimbursement comes off the month of its purchase.</p>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr><th>Category</th>{data.months.map((m) => <th key={m} className="num"><a href={`#/month/${m}`}>{monthLabel(m, 'short')}</a></th>)}<th className="num">Year</th></tr>
            </thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.name}><td><span className="cat" style={{ background: c.color }}>{c.name}</span></td>{c.cents.map((v, i) => <td key={i} className="num">{cell(v)}</td>)}<td className="num strong">{cell(sum(c.cents))}</td></tr>
              ))}
              <tr className="total"><td>Total</td>{totals.map((v, i) => <td key={i} className="num">{cell(v)}</td>)}<td className="num">{cell(yearSpend)}</td></tr>
              <tr><td>% of income</td>{totals.map((v, i) => <td key={i} className="num">{percent(v, data.income[i])}</td>)}<td className="num strong">{percent(yearSpend, yearIncome)}</td></tr>
              <tr><td><a href="#/transactions/income">Income</a></td>{data.income.map((v, i) => <td key={i} className="num">{cell(v)}</td>)}<td className="num strong">{cell(yearIncome)}</td></tr>
              <tr><td><a href="#/transactions/income">Income</a> one-off</td>{data.one_off_income.map((v, i) => <td key={i} className="num">{cell(v)}</td>)}<td className="num strong">{cell(sum(data.one_off_income))}</td></tr>
              <tr><td>One-off spending</td>{data.one_off.map((v, i) => <td key={i} className="num">{cell(v)}</td>)}<td className="num strong">{cell(sum(data.one_off))}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
