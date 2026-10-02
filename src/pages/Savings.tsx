import { Fragment, useState } from 'react'
import type { AccountType, Tx, YearSummary } from '../../shared/types.ts'
import { query } from '../api.ts'
import { TxTable } from '../components/TxTable.tsx'
import { money, moneyWhole, monthLabel, percent } from '../format.ts'
import { useLoad } from '../hooks.ts'
import { sum, YearPicker } from './Spending.tsx'

const GROUPS: [AccountType, string][] = [['savings', 'Savings'], ['investment', 'Investments'], ['retirement', 'Retirement']]

/** Every move in or out of one account during the year, one line each. */
function Lines({ accountId, year, onChanged }: { accountId: number; year: number; onChanged: () => void }) {
  const { data, reload } = useLoad<{ rows: Tx[] }>(`/api/transactions${query({ account: accountId, kind: 'transfer', limit: 5000 })}`)
  const rows = (data?.rows ?? []).filter((tx) => tx.month.startsWith(`${year}-`))
  if (!data) return null
  if (rows.length === 0) return <p className="muted empty">Nothing moved in or out of this account in {year}.</p>
  return <TxTable rows={rows} perAccount withYear onChanged={() => { void reload(); onChanged() }} />
}

export function Savings() {
  const [year, setYear] = useState(new Date().getFullYear())
  const { data, reload } = useLoad<YearSummary>(`/api/year/${year}`)
  const [picked, setPicked] = useState<number | null>(null)
  if (!data || data.year !== year) return <div className="heading"><YearPicker year={year} setYear={setYear} /></div>

  // Open on the first account that has anything in it this year.
  const shown = picked ?? (data.contributions.find((a) => a.cents.some(Boolean)) ?? data.contributions[0])?.account_id ?? null
  const income = sum(data.income)
  const groupMonths = (type: AccountType) => data.months.map((_, i) => sum(data.contributions.filter((a) => a.type === type).map((a) => a.cents[i])))
  const cell = (cents: number) => (cents === 0 ? <span className="muted">–</span> : moneyWhole(cents))
  const all = data.months.map((_, i) => sum(data.contributions.map((a) => a.cents[i])))
  // Percentages are of take-home income, so they leave out what was deducted before the paycheck arrived.
  const takeHome = (type?: AccountType) => data.months.map((_, i) => sum(data.contributions.filter((a) => !type || a.type === type).map((a) => a.cents[i] - a.paycheck[i])))
  const fromPaycheck = sum(data.contributions.flatMap((a) => a.paycheck))
  return (
    <>
      <div className="heading"><YearPicker year={year} setYear={setYear} /><span className="muted">Savings</span></div>
      <div className="tiles">
        {GROUPS.map(([type, label]) => {
          const total = sum(groupMonths(type))
          return <div className="tile" key={type}><span>{label} this year</span><strong>{money(total)}</strong><em>{percent(sum(takeHome(type)), income)} of take-home income</em></div>
        })}
        <div className="tile"><span>Total put away</span><strong>{money(sum(all))}</strong><em>{percent(sum(takeHome()), income)} of take-home income</em></div>
      </div>
      {fromPaycheck !== 0 && <p className="muted small">Percentages leave out the {money(fromPaycheck)} deducted from your paycheck (401k), since that never reached your take-home pay. The amounts include it.</p>}
      <section className="card">
        <h2>Money moved in, by month</h2>
        <p className="muted small">
          Net of anything moved back out. A move between two savings accounts cancels out in the subtotal.
          Add these as transfers on the Month screen; contributions taken from your paycheck use "Paycheck" as the source.
        </p>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr><th>Account</th>{data.months.map((m) => <th key={m} className="num"><a href={`#/month/${m}`}>{monthLabel(m, 'short')}</a></th>)}<th className="num">Year</th></tr>
            </thead>
            <tbody>
              {GROUPS.map(([type, label]) => (
                <Fragment key={type}>
                  {data.contributions.filter((a) => a.type === type).map((a) => (
                    <tr key={a.account_id}><td>{a.name}</td>{a.cents.map((v, i) => <td key={i} className="num">{cell(v)}</td>)}<td className="num strong">{cell(sum(a.cents))}</td></tr>
                  ))}
                  <tr className="total"><td>{label}</td>{groupMonths(type).map((v, i) => <td key={i} className="num">{cell(v)}</td>)}<td className="num">{cell(sum(groupMonths(type)))}</td></tr>
                </Fragment>
              ))}
              <tr><td>% of take-home income</td>{takeHome().map((v, i) => <td key={i} className="num">{percent(v, data.income[i])}</td>)}<td className="num strong">{percent(sum(takeHome()), income)}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>Line by line</h2>
        <div className="tabs wrap" role="tablist" aria-label="Account">
          {data.contributions.map((a) => (
            <button key={a.account_id} type="button" role="tab" aria-selected={shown === a.account_id} className={shown === a.account_id ? 'active' : ''} onClick={() => setPicked(a.account_id)}>
              {a.name} <span className="muted">{sum(a.cents) === 0 ? '–' : moneyWhole(sum(a.cents))}</span>
            </button>
          ))}
        </div>
        {shown !== null && <Lines key={`${shown}-${year}`} accountId={shown} year={year} onChanged={() => void reload()} />}
      </section>
    </>
  )
}
