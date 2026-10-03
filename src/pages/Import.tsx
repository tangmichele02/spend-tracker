import { useMemo, useState } from 'react'
import { guessRoles, parseAmount, parseRows, splitRows, type Role } from '../../shared/parse.ts'
import { api } from '../api.ts'
import { useData } from '../App.tsx'
import { currentMonth, dateLabel, money, monthLabel } from '../format.ts'
import { stored } from '../hooks.ts'

interface Counts { inserted: number; skipped: number; moved: number }
const summarize = (res: Counts) =>
  `Added ${res.inserted}.${res.moved ? ` Moved ${res.moved} already in the app to this month.` : ''}${res.skipped ? ` Skipped ${res.skipped} already in the app.` : ''}`

type Mode = 'purchase' | 'income' | 'reimbursement' | 'transfer' | 'balances'
const MODES: [Mode, string, string][] = [
  ['purchase', 'Purchases', 'Description, amount, date, category'],
  ['income', 'Income', 'Source, amount, date'],
  ['reimbursement', 'Reimbursements', 'Description, amount, date, category'],
  ['transfer', 'Transfers: internal, savings, investments, 401k', 'Date and amount, for one pair of accounts at a time'],
  ['balances', 'Net worth balances', 'A date column and one column per account, with the header row (like the Savings Record table)'],
]

// Spreadsheet headers that do not contain the account's name.
const HEADER_ALIASES: [(header: string) => boolean, (a: { name: string; type: string }) => boolean][] = [
  [(h) => h === 'individual' || h === 'brokerage', (a) => a.type === 'investment'],
  [(h) => h === 'roth', (a) => a.name.toLowerCase() === 'roth ira'],
  // Marcus and Bread were tracked as one figure, now kept under Bread.
  [(h) => h.includes('bread'), (a) => a.name.toLowerCase() === 'bread'],
]

export function Import({ month: fromLink, balances }: { month?: string; balances?: boolean }) {
  const { accounts, categories, reload } = useData()
  const spendable = accounts.filter((a) => !a.archived && a.type === 'checking')
  const netWorth = accounts.filter((a) => a.in_net_worth)
  const [mode, setMode] = useState<Mode>(balances ? 'balances' : 'purchase')
  // Month (YYYY-MM) every pasted row is filed under, whatever its date. Rows with no date are dated the 1st.
  const [fileMonth, setFileMonth] = useState(() => fromLink ?? stored('last-month') ?? currentMonth())
  const [byDate, setByDate] = useState(false)
  const month = !byDate && /^\d{4}-\d{2}$/.test(fileMonth) ? fileMonth : undefined
  const fallbackDate = month ? `${month}-01` : ''
  const [fromId, setFromId] = useState(String(spendable[0]?.id ?? ''))
  const [toId, setToId] = useState('')
  const destinations = accounts.filter((a) => !a.archived && String(a.id) !== fromId)
  const [accountId, setAccountId] = useState(String(spendable[0]?.id ?? ''))
  const [year, setYear] = useState(new Date().getFullYear())
  const [text, setText] = useState('')
  // Preview rows the user removed, by row number in the pasted text.
  const [removed, setRemoved] = useState<Set<number>>(new Set())
  const [override, setOverride] = useState<Record<number, Role>>({})
  const [result, setResult] = useState('')
  const [error, setError] = useState('')

  const rows = useMemo(() => splitRows(text).filter((r) => r.some((c) => c !== '')), [text])
  const roles = useMemo(() => {
    let guessed = guessRoles(rows, categories, year)
    if (mode === 'balances') {
      // Match each header cell to an account by name; everything else is ignored until chosen.
      const header = rows[0] ?? []
      guessed = guessed.map((role, i) => {
        if (role === 'date') return role
        const name = (header[i] ?? '').trim().toLowerCase()
        const alias = HEADER_ALIASES.find(([test]) => test(name))?.[1]
        const hit = name && (netWorth.find((a) => a.name.toLowerCase() === name)
          ?? (alias && netWorth.find(alias))
          ?? netWorth.find((a) => a.name.toLowerCase().includes(name) || name.includes(a.name.toLowerCase())))
        return hit ? (`account:${hit.id}` as Role) : 'ignore'
      })
    } else if (mode === 'income' || mode === 'transfer') {
      guessed = guessed.map((r) => (r === 'category' ? 'ignore' : r))
    }
    return guessed.map((r, i) => override[i] ?? r)
  }, [rows, categories, year, mode, override, netWorth])
  const { parsed: all, skipped } = useMemo(() => parseRows(rows, roles, categories, year), [rows, roles, categories, year])
  const parsed = all.filter((r) => !removed.has(r.line)).map((r) => {
    // Blocks without a date column (internal transfers, the savings lines on a month tab) take the date typed above.
    if (r.date !== null || !fallbackDate || mode === 'balances') return r
    return { ...r, date: fallbackDate, errors: r.errors.filter((e) => e !== 'missing date') }
  })
  const good = parsed.filter((r) => r.errors.length === 0)
  // Balance columns with numbers in them that are not going anywhere (an unmatched header, or a total).
  const ignoredAmounts = mode !== 'balances' ? [] : roles.flatMap((role, i) => {
    if (role !== 'ignore') return []
    const header = (rows[0]?.[i] ?? '').trim()
    const hasAmounts = rows.slice(1).some((r) => parseAmount(r[i] ?? '') !== null)
    return hasAmounts && !/total/i.test(header) ? [header || `Column ${i + 1}`] : []
  })
  const bad = parsed.filter((r) => r.errors.length > 0)
  const warned = good.filter((r) => r.warnings.length > 0)

  const roleOptions: [Role, string][] = mode === 'balances'
    ? [['date', 'Date'], ...netWorth.map((a) => [`account:${a.id}`, a.name] as [Role, string]), ['ignore', 'Ignore']]
    : [['description', mode === 'income' ? 'Source' : mode === 'transfer' ? 'Note' : 'Description'], ['amount', 'Amount'], ['date', 'Date'],
       ...(mode === 'income' || mode === 'transfer' ? [] : [['category', 'Category'] as [Role, string]]), ['ignore', 'Ignore']]

  async function run() {
    setError('')
    try {
      if (mode === 'transfer') {
        if (!toId) return setError('Choose which account the money went into')
        const res = await api<Counts>('POST', '/api/import-transfers', {
          // A negative amount is money coming back out, so the direction flips.
          rows: good.map((r) => {
            const out = r.amount_cents! < 0
            if (out && !fromId) throw new Error(`Row ${r.line} is negative, which cannot come from a paycheck`)
            return {
              date: r.date, month, amount_cents: Math.abs(r.amount_cents!), description: r.description,
              from_account_id: out ? +toId : fromId ? +fromId : null, to_account_id: out ? +fromId : +toId,
            }
          }),
        })
        setResult(summarize(res))
      } else if (mode === 'balances') {
        const snapshots = good.flatMap((r) => r.balances.map((b) => ({ ...b, date: r.date! })))
        await api('POST', '/api/snapshots', { rows: snapshots })
        setResult(`Saved ${snapshots.length} balances across ${good.length} dates.`)
      } else {
        const res = await api<Counts>('POST', '/api/import', {
          rows: good.map((r) => ({
            kind: mode, date: r.date, month, account_id: +accountId, amount_cents: r.amount_cents,
            description: r.description, category_id: mode === 'income' ? null : r.category_id,
          })),
        })
        setResult(summarize(res))
      }
      setText('')
      setRemoved(new Set())
      setOverride({})
      void reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const categoryName = (id: number | null) => categories.find((c) => c.id === id)?.name ?? ''
  return (
    <>
      <div className="heading"><h1>Import</h1></div>
      <section className="card">
        <p>Copy a block of cells from your spreadsheet and paste it below. Nothing is saved until you press Import, and pasting the same block twice adds nothing.</p>
        <div className="fields">
          <label>What is it
            <select value={mode} onChange={(e) => { setMode(e.target.value as Mode); setOverride({}); setResult('') }}>
              {MODES.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
            </select>
          </label>
          {mode === 'transfer' && (
            <>
              <label>From
                <select value={fromId} onChange={(e) => { setFromId(e.target.value); if (e.target.value === toId) setToId('') }}>
                  {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  <option value="">Paycheck (never in checking)</option>
                </select>
              </label>
              <label>Into
                <select value={toId} onChange={(e) => setToId(e.target.value)}>
                  <option value="">Choose…</option>
                  {destinations.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            </>
          )}
          {mode !== 'balances' && mode !== 'transfer' && (
            <label>{mode === 'purchase' ? 'Paid from' : 'Into'}
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {spendable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          )}
          <label>Year for dates without one<input type="number" value={year} onChange={(e) => setYear(+e.target.value)} className="num short" /></label>
          {mode !== 'balances' && (
            <>
              <label>Count in month<input type="month" value={fileMonth} disabled={byDate} onChange={(e) => setFileMonth(e.target.value)} /></label>
              <label className="check"><input type="checkbox" checked={byDate} onChange={(e) => setByDate(e.target.checked)} />Use each row's own date instead</label>
            </>
          )}
        </div>
        {mode === 'transfer' && (
          <p className="muted small">
            For a Zelle between your checking accounts, choose one as From and the other as Into: it moves the money between the two balances and is never income or spending.
            To take money back out, choose the savings or investment account as From and the checking account as Into. It shows under Internal transfers for that checking account and lowers that month's savings or investment total; it is never income.
            For savings and investments, paste the Date and Amount columns for one account from your Savings tab; money moved out of checking lowers that checking balance.
            For 401k and other paycheck deductions, choose "Paycheck" as the source: they count toward retirement but never touch a checking balance or your take-home income.
          </p>
        )}
        {mode !== 'balances' && (
          <p className="muted small">
            {month
              ? `Every row will count in ${monthLabel(month)}, whatever its date. Rows with no date are dated the 1st.`
              : 'Each row will count in the month of its own date. Rows with no date are left out.'}
          </p>
        )}
        <p className="muted small">Expected columns: {MODES.find(([m]) => m === mode)![2]}. Any order works; correct the guesses above each column if needed.</p>
        <textarea value={text} onChange={(e) => { setText(e.target.value); setRemoved(new Set()); setResult('') }} rows={8} spellCheck={false}
          placeholder="Paste here" aria-label="Pasted cells" />
        {result && <p role="status"><strong>{result}</strong></p>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {rows.length > 0 && (
        <section className="card">
          <div className="row">
            <h2>Preview</h2>
            <button className="primary" type="button" disabled={good.length === 0} onClick={() => void run()}>
              Import {good.length} row{good.length === 1 ? '' : 's'}{month && mode !== 'balances' ? ` into ${monthLabel(month)}` : ''}
            </button>
          </div>
          <p className="muted small">
            {good.length} ready
            {bad.length > 0 && ` · ${bad.length} with problems (left out)`}
            {warned.length > 0 && ` · ${warned.length} with an unknown category (imported without one)`}
            {skipped > 0 && ` · ${skipped} blank or header rows ignored`}
            {removed.size > 0 && <> · {removed.size} removed <button type="button" className="inline" onClick={() => setRemoved(new Set())}>Undo</button></>}
          </p>
          {ignoredAmounts.length > 0 && (
            <p className="error small" role="alert">
              ⚠ {ignoredAmounts.map((h) => `“${h}”`).join(', ')} {ignoredAmounts.length === 1 ? 'has' : 'have'} amounts but {ignoredAmounts.length === 1 ? 'is' : 'are'} set to Ignore, so {ignoredAmounts.length === 1 ? 'it' : 'they'} won't be imported. Choose an account above the column{ignoredAmounts.length === 1 ? '' : 's'}, or leave as is for totals.
            </p>
          )}
          <div className="table-wrap">
            <table className="grid preview">
              <thead>
                <tr>
                  <th>Row</th>
                  {roles.map((role, i) => (
                    <th key={i}>
                      <select value={role} aria-label={`Column ${i + 1} holds`} onChange={(e) => setOverride({ ...override, [i]: e.target.value as Role })}>
                        {roleOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </th>
                  ))}
                  <th>Reads as</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {parsed.slice(0, 300).map((r) => (
                  <tr key={r.line} className={r.errors.length ? 'bad' : ''}>
                    <td className="muted">{r.line}</td>
                    {roles.map((_, i) => <td key={i}>{rows[r.line - 1][i] ?? ''}</td>)}
                    <td>
                      {r.errors.length > 0 ? <span className="error">⚠ {r.errors.join(', ')}</span>
                        : mode === 'balances' ? `${dateLabel(r.date!, true)} · ${r.balances.length} balance${r.balances.length === 1 ? '' : 's'}`
                        : <>{dateLabel(r.date!, true)} · {money(r.amount_cents!)}{r.category_id ? ` · ${categoryName(r.category_id)}` : ''}{r.warnings.length > 0 && <span className="tag">no category</span>}</>}
                    </td>
                    <td className="actions">
                      <button type="button" aria-label={`Remove row ${r.line}`} title="Leave this row out" onClick={() => setRemoved(new Set(removed).add(r.line))}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {parsed.length > 300 && <p className="muted small">Showing the first 300 of {parsed.length} rows.</p>}
        </section>
      )}
    </>
  )
}
