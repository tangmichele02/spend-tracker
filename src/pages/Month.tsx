import { useCallback, useEffect, useState } from 'react'
import { useData } from '../App.tsx'
import type { MonthSummary, Tx } from '../../shared/types.ts'
import { query } from '../api.ts'
import { BarList } from '../charts.tsx'
import { EntryForm } from '../components/EntryForm.tsx'
import { TxTable } from '../components/TxTable.tsx'
import { currentMonth, MIN_YEAR, money, monthLabel, percent, shiftMonth, today } from '../format.ts'
import { store, stored, useLoad } from '../hooks.ts'

type AccountRow = MonthSummary['accounts'][number]

const SECTIONS = [
  ['income', 'Income', '+'],
  ['spending', 'Spending', '−'],
  ['reimbursements', 'Reimbursements', '+'],
  ['moved', 'Savings and investments', '−'],
  ['internal', 'Internal transfers', '±'],
] as const
type SectionKey = (typeof SECTIONS)[number][0]

/** One checking account for the month, laid out like a spreadsheet tab: each kind of entry in its own block, and the sum that links them. */
function AccountColumn({ account, month, version, onChanged, onReimburse }: {
  account: AccountRow; month: string; version: number; onChanged: () => void; onReimburse: (tx: Tx) => void
}) {
  const { accounts } = useData()
  const { data, reload } = useLoad<{ rows: Tx[] }>(`/api/transactions${query({ month, account: account.id, limit: 5000 })}`)
  useEffect(() => { void reload() }, [version, reload])
  const rows = data?.rows ?? []

  const isChecking = (name: string | null) => accounts.some((a) => a.name === name && a.type === 'checking')
  const sectionOf = (tx: Tx): SectionKey =>
    tx.kind === 'income' ? 'income'
    : tx.kind === 'purchase' ? 'spending'
    : tx.kind === 'reimbursement' ? 'reimbursements'
    // Money coming in from any of your own accounts, or going to the other checking account, is internal.
    : (tx.amount_cents > 0 && tx.other_account_name !== null) || isChecking(tx.other_account_name) ? 'internal' : 'moved'
  const groups = Object.fromEntries(SECTIONS.map(([key]) => [key, rows.filter((tx) => sectionOf(tx) === key)])) as Record<SectionKey, Tx[]>
  // Signed from this account's side: money in is positive.
  const net = (key: SectionKey) => groups[key].reduce((n, tx) => n + tx.amount_cents, 0)
  const start = account.balance_cents - rows.reduce((n, tx) => n + tx.amount_cents, 0)
  const signed = (cents: number) => (cents > 0 ? `+${money(cents)}` : money(cents))

  return (
    <section className="card account">
      <div className="row"><h2>{account.name}</h2><strong className="num">{money(account.balance_cents)}</strong></div>
      <table className="sum">
        <tbody>
          <tr><td>Start of {monthLabel(month, 'short')}</td><td className="num">{money(start)}</td></tr>
          {SECTIONS.map(([key, label]) => (
            <tr key={key}><td>{label}</td><td className="num">{net(key) === 0 ? <span className="muted">–</span> : signed(net(key))}</td></tr>
          ))}
          <tr className="total"><td>End of {monthLabel(month, 'short')}</td><td className="num">{money(account.balance_cents)}</td></tr>
        </tbody>
      </table>
      {SECTIONS.map(([key, label]) => (
        <div key={key} className="block">
          <div className="row"><h3>{label} <span className="muted">({groups[key].length})</span></h3><span className="num">{signed(net(key))}</span></div>
          {groups[key].length > 0 && <TxTable rows={groups[key]} onChanged={onChanged} onReimburse={key === 'spending' ? onReimburse : undefined} perAccount />}
        </div>
      ))}
    </section>
  )
}

export function Month({ month }: { month: string }) {
  const summary = useLoad<MonthSummary>(`/api/month/${month}`)
  const list = useLoad<{ rows: Tx[] }>(`/api/transactions${query({ month, limit: 5000 })}`)
  const [reimburse, setReimburse] = useState<Tx | null>(null)
  const handled = useCallback(() => setReimburse(null), [])
  const [version, setVersion] = useState(0)
  const [view, setView] = useState(() => (stored('month-view') === 'combined' ? 'combined' : 'accounts'))
  const refresh = () => { void summary.reload(); void list.reload(); setVersion((v) => v + 1) }
  const pickView = (v: string) => { setView(v); store('month-view', v) }
  // Contributions taken from a paycheck never touch checking; they are listed on the Savings page instead.
  const isPayroll = (tx: Tx) => tx.kind === 'transfer' && !tx.other_account_name
  // Moves that never pass through checking, such as savings straight into a Roth IRA.
  const { accounts: allAccounts } = useData()
  const isChecking = (name: string | null) => allAccounts.some((a) => a.name === name && a.type === 'checking')
  const between = (list.data?.rows ?? []).filter((tx) => tx.kind === 'transfer' && tx.other_account_name && !isChecking(tx.account_name) && !isChecking(tx.other_account_name))

  // Import defaults to the month last looked at.
  useEffect(() => store('last-month', month), [month])
  const s = summary.data
  const year = +month.slice(0, 4)
  const lastYear = Math.max(new Date().getFullYear(), year)
  const years = Array.from({ length: lastYear - MIN_YEAR + 1 }, (_, i) => MIN_YEAR + i)
  const defaultDate = month === currentMonth() ? today() : `${month}-01`
  return (
    <>
      <div className="heading">
        {month > `${MIN_YEAR}-01`
          ? <a className="button" href={`#/month/${shiftMonth(month, -1)}`} aria-label="Previous month">‹</a>
          : <button type="button" disabled aria-label="Previous month">‹</button>}
        <h1>{monthLabel(month)}</h1>
        <a className="button" href={`#/month/${shiftMonth(month, 1)}`} aria-label="Next month">›</a>
        {month !== currentMonth() && <a className="button" href={`#/month/${currentMonth()}`}>This month</a>}
        <a className="button push" href={`#/reconcile/${month}`}>Reconcile with bank</a>
        <a className="button" href={`#/import/${month}`}>Paste rows into {monthLabel(month, 'short')}</a>
      </div>
      <nav className="months" aria-label="Jump to month">
        <select value={year} aria-label="Year" onChange={(e) => { window.location.hash = `#/month/${e.target.value}-${month.slice(5)}` }}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        {Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`).map((m) => (
          <a key={m} href={`#/month/${m}`} className={m === month ? 'active' : ''} aria-current={m === month ? 'page' : undefined}>{monthLabel(m, 'short')}</a>
        ))}
      </nav>
      {s && (
        <div className="tiles">
          <div className="tile lead">
            <div className="each">
              {s.accounts.map((a) => (
                <div key={a.id}><span>{a.name}</span><strong>{money(a.balance_cents)}</strong></div>
              ))}
            </div>
            <em>
              Checking total {money(s.accounts.reduce((n, a) => n + a.balance_cents, 0))}
              {month === currentMonth() ? '' : ` · end of ${monthLabel(month, 'short')}`}
            </em>
          </div>
          <div className="tile"><span>Income</span><strong>{money(s.income_cents)}</strong>{s.one_off_income_cents !== 0 && <em>plus {money(s.one_off_income_cents)} one-off</em>}</div>
          <div className="tile"><span>Spending</span><strong>{money(s.spending_cents)}</strong><em>{percent(s.spending_cents, s.income_cents)} of income</em></div>
          {s.one_off_cents !== 0 && <div className="tile"><span>One-off spending</span><strong>{money(s.one_off_cents)}</strong><em>not in spending</em></div>}
          <div className="tile"><span>Savings</span><strong>{money(s.moved.savings)}</strong><em>{percent(s.moved.savings, s.income_cents)} of income</em></div>
          <div className="tile"><span>Investments</span><strong>{money(s.moved.investment)}</strong><em>{percent(s.moved.investment, s.income_cents)} of income</em></div>
          <div className="tile"><span>Retirement</span><strong>{money(s.moved.retirement)}</strong><em><a href="#/savings">Details on Savings</a></em></div>
        </div>
      )}
      <EntryForm month={month} defaultDate={defaultDate} onSaved={refresh} reimburse={reimburse} onReimburseHandled={handled} />
      <div className="tabs view" role="tablist" aria-label="Layout">
        <button type="button" role="tab" aria-selected={view === 'accounts'} className={view === 'accounts' ? 'active' : ''} onClick={() => pickView('accounts')}>By account</button>
        <button type="button" role="tab" aria-selected={view === 'combined'} className={view === 'combined' ? 'active' : ''} onClick={() => pickView('combined')}>Combined list</button>
      </div>
      {view === 'accounts' && (
        <>
          <div className="columns">
            {s?.accounts.map((a) => <AccountColumn key={a.id} account={a} month={month} version={version} onChanged={refresh} onReimburse={setReimburse} />)}
          </div>
          {between.length > 0 && (
            <section className="card">
              <div className="row"><h2>Between savings and investment accounts <span className="muted">({between.length})</span></h2></div>
              <p className="muted small">Money moved from one to another without passing through checking. It lowers one total and raises the other by the same amount.</p>
              <TxTable rows={between} onChanged={refresh} />
            </section>
          )}
          <section className="card">
            <h2>Spending by category</h2>
            {s && s.categories.length > 0
              ? <BarList rows={s.categories.map((c) => ({ label: c.name, cents: c.cents, color: c.color }))} />
              : <p className="muted empty">No spending this month.</p>}
          </section>
        </>
      )}
      {view === 'combined' && <div className="split">
        <section className="card">
          <h2>Entries</h2>
          <TxTable rows={(list.data?.rows ?? []).filter((tx) => !isPayroll(tx))} onChanged={refresh} onReimburse={setReimburse} />
        </section>
        <aside>
          <section className="card">
            <h2>Spending by category</h2>
            {s && s.categories.length > 0
              ? <BarList rows={s.categories.map((c) => ({ label: c.name, cents: c.cents, color: c.color }))} />
              : <p className="muted empty">No spending this month.</p>}
          </section>
        </aside>
      </div>}
    </>
  )
}
