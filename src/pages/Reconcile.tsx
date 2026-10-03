import { useEffect, useMemo, useState } from 'react'
import { parseAmount } from '../../shared/parse.ts'
import { FORMAT_NAMES, parseStatement, type ParsedStatement } from '../../shared/statements.ts'
import type { Card, Category, Proposal, ReconcileLine, ReconcileView, ResolveInput } from '../../shared/types.ts'
import { api } from '../api.ts'
import { useData } from '../App.tsx'
import { TxTable } from '../components/TxTable.tsx'
import { amountField, currentMonth, dateLabel, lastDay, MIN_YEAR, money, monthLabel, shiftMonth } from '../format.ts'
import { store, stored, useLoad } from '../hooks.ts'

const signed = (cents: number) => (cents > 0 ? `+${money(cents)}` : money(cents))

function CategorySelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const { categories } = useData()
  return (
    <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      <option value="">No category</option>
      {categories.filter((c: Category) => !c.archived).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  )
}

// ---- Loading files ----

interface Pending { name: string; parsed: ParsedStatement; target: string; newName: string; newLast4: string; result: string }

function LoadFiles({ cards, onLoaded }: { cards: Card[]; onLoaded: () => void }) {
  const { accounts } = useData()
  const checking = accounts.filter((a) => a.type === 'checking' && !a.archived)
  const [files, setFiles] = useState<Pending[]>([])
  const [error, setError] = useState('')

  function defaultTarget(p: ParsedStatement): string {
    if (p.kind === 'bank') {
      const want = p.format === 'chase-checking' ? 'chase' : 'us bank'
      return String((checking.find((a) => a.name.toLowerCase().includes(want)) ?? checking[0])?.id ?? '')
    }
    const issuer = p.format === 'chase-card' ? 'chase' : 'capitalone'
    const last4 = p.lines.find((l) => l.last4)?.last4
    const byDigits = last4 && cards.find((c) => c.issuer === issuer && c.last4 === last4)
    const same = cards.filter((c) => c.issuer === issuer)
    return byDigits ? String(byDigits.id) : same.length === 1 ? String(same[0].id) : 'new'
  }

  async function pick(list: FileList | null) {
    setError('')
    const next: Pending[] = []
    for (const file of Array.from(list ?? [])) {
      const parsed = parseStatement(await file.text())
      if ('error' in parsed) { setError(`${file.name}: ${parsed.error}`); continue }
      const last4 = parsed.kind === 'card' ? parsed.lines.find((l) => l.last4)?.last4 ?? '' : ''
      next.push({ name: file.name, parsed, target: defaultTarget(parsed), newName: parsed.format === 'capitalone-card' ? 'Capital One' : '', newLast4: last4, result: '' })
    }
    setFiles(next)
  }

  async function load(i: number) {
    const f = files[i]
    try {
      let target = f.target
      if (f.parsed.kind === 'card' && target === 'new') {
        if (!f.newName.trim()) throw new Error('Give the card a name')
        const card = await api<Card>('POST', '/api/cards', { name: f.newName, issuer: f.parsed.format === 'chase-card' ? 'chase' : 'capitalone', last4: f.newLast4 })
        target = String(card.id)
      }
      const res = await api<{ added: number; already: number }>('POST', '/api/statements', f.parsed.kind === 'bank'
        ? { kind: 'bank', account_id: +target, lines: f.parsed.lines }
        : { kind: 'card', card_id: +target, lines: f.parsed.lines })
      setFiles((fs) => fs.map((x, j) => (j === i ? { ...x, target, result: `Loaded ${res.added} new line${res.added === 1 ? '' : 's'}${res.already ? `, ${res.already} already loaded` : ''}.` } : x)))
      onLoaded()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const set = (i: number, patch: Partial<Pending>) => setFiles((fs) => fs.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  return (
    <section className="card">
      <h2>Load exports</h2>
      <p className="muted small">
        Choose your checking CSV and the card CSVs covering the same weeks, including a few days before the month starts.
        Files are read on this Mac only. Loading an overlapping file again only adds the lines that are new.
      </p>
      <input type="file" multiple accept=".csv,text/csv,text/plain" aria-label="Export files" onChange={(e) => { void pick(e.target.files); e.target.value = '' }} />
      {files.length > 0 && (
        <ul className="files">
          {files.map((f, i) => {
            const issuer = f.parsed.format === 'chase-card' ? 'chase' : 'capitalone'
            return (
              <li key={f.name}>
                <div className="row">
                  <span><strong>{f.name}</strong> <span className="muted">· {FORMAT_NAMES[f.parsed.format]} · {f.parsed.lines.length} lines</span></span>
                  {f.result ? <span className="status good"><span>✓ {f.result}</span></span> : (
                    <span className="row">
                      {f.parsed.kind === 'bank' ? (
                        <select value={f.target} aria-label="Account" onChange={(e) => set(i, { target: e.target.value })}>
                          {checking.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      ) : (
                        <>
                          <select value={f.target} aria-label="Card" onChange={(e) => set(i, { target: e.target.value })}>
                            {cards.filter((c) => c.issuer === issuer).map((c) => <option key={c.id} value={c.id}>{c.name}{c.last4 ? ` ··${c.last4}` : ''}</option>)}
                            <option value="new">New card…</option>
                          </select>
                          {f.target === 'new' && (
                            <>
                              <input value={f.newName} placeholder="Card name" aria-label="Card name" onChange={(e) => set(i, { newName: e.target.value })} />
                              <input value={f.newLast4} placeholder="Last 4" aria-label="Last four digits" className="short" onChange={(e) => set(i, { newLast4: e.target.value })} />
                            </>
                          )}
                        </>
                      )}
                      <button type="button" className="primary" onClick={() => void load(i)}>Load</button>
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}

// ---- Resolving one line ----

function CardResolver({ line, proposal, onDone }: { line: ReconcileLine; proposal: Extract<Proposal, { kind: 'card' }>; onDone: (body: ResolveInput) => void }) {
  const [picked, setPicked] = useState(() => new Set(proposal.items.filter((i) => i.proposed).map((i) => i.id)))
  const [cats, setCats] = useState<Record<number, string>>({})
  // Lines typed in for charges the card export does not include.
  const [manual, setManual] = useState<{ date: string; description: string; amount: string; category: string }[]>([])
  const manualCents = manual.map((m) => parseAmount(m.amount) ?? 0)
  const total = proposal.items.filter((i) => picked.has(i.id)).reduce((n, i) => n + i.amount_cents, 0) + manualCents.reduce((n, c) => n + c, 0)
  const target = -line.amount_cents
  const addManual = (cents: number) => setManual((ms) => [...ms, { date: line.date, description: '', amount: cents > 0 ? amountField(cents) : '', category: '' }])
  const setRow = (i: number, patch: Partial<(typeof manual)[number]>) => setManual((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <div className="resolver">
      <p className="small">
        Payment to <strong>{proposal.card.name}</strong> (the card shows it on {dateLabel(proposal.payment.date)}).
        {proposal.exact ? ' These card lines add up to it exactly:' : ' No set of lines adds up exactly; tick the ones it paid.'}
      </p>
      <div className="table-wrap">
        <table className="tx">
          <thead><tr><th className="tick">Paid</th><th>Card date</th><th>Description</th><th>Category</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {proposal.items.map((i) => (
              <tr key={i.id} className={picked.has(i.id) ? '' : 'faded'}>
                <td className="tick"><input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} aria-label={`Paid by this payment: ${i.description}`} /></td>
                <td className="nowrap">{dateLabel(i.date)}</td>
                <td>
                  {i.description}
                  {i.amount_cents < 0 && <span className="tag reimbursement">refund</span>}
                  {i.existing && <span className="tag">already entered as “{i.existing.description}”</span>}
                </td>
                <td>
                  {i.existing?.category_name && !cats[i.id]
                    ? <span className="muted small">{i.existing.category_name}</span>
                    : <CategorySelect value={cats[i.id] ?? ''} onChange={(v) => setCats({ ...cats, [i.id]: v })} label={`Category for ${i.description}`} />}
                </td>
                <td className="num nowrap">{i.amount_cents < 0 ? `−${money(-i.amount_cents)}` : money(i.amount_cents)}</td>
              </tr>
            ))}
            {manual.map((m, i) => (
              <tr key={`m${i}`} className="editing">
                <td className="tick"><button type="button" aria-label="Remove added line" onClick={() => setManual((ms) => ms.filter((_, j) => j !== i))}>×</button></td>
                <td><input type="date" value={m.date} aria-label="Date of added line" onChange={(e) => setRow(i, { date: e.target.value })} /></td>
                <td><input value={m.description} placeholder="Description" aria-label="Description of added line" onChange={(e) => setRow(i, { description: e.target.value })} /></td>
                <td><CategorySelect value={m.category} onChange={(v) => setRow(i, { category: v })} label="Category of added line" /></td>
                <td className="num"><input className="num" inputMode="decimal" value={m.amount} placeholder="0.00" aria-label="Amount of added line" title="Use a minus sign for a refund" onChange={(e) => setRow(i, { amount: e.target.value })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <span className="row">
          {total !== target && target - total > 0 && <button type="button" onClick={() => addManual(target - total)}>Add the missing {money(target - total)} as a line</button>}
          <button type="button" onClick={() => addManual(0)}>Add a line yourself</button>
        </span>
        <span className="muted small">For charges missing from the card export. A minus sign makes it a refund.</span>
      </div>
      <div className="row">
        <span className={total === target ? 'status good' : 'status bad'}>
          <span>{total === target ? '✓ Adds up' : `⚠ Ticked lines total ${money(total)}; the payment is ${money(target)} (${total > target ? 'over' : 'short'} by ${money(Math.abs(total - target))})`}</span>
        </span>
        <button type="button" className="primary" disabled={total !== target} onClick={() => onDone({
          bank_line_id: line.id, action: 'card', card_payment_id: proposal.payment.id,
          items: proposal.items.filter((i) => picked.has(i.id)).map((i) => ({ card_line_id: i.id, category_id: cats[i.id] ? +cats[i.id] : null, existing_tx_id: i.existing?.id ?? null })),
          manual: manual.map((m, i) => ({ date: m.date, description: m.description, amount_cents: manualCents[i], category_id: m.category ? +m.category : null })),
        })}>Record {picked.size + manual.length} line{picked.size + manual.length === 1 ? '' : 's'}</button>
      </div>
    </div>
  )
}

type EntryType = 'purchase' | 'income' | 'reimbursement' | 'transfer' | 'ignore'
interface Part { date: string; amount: string; description: string; category: string }

function EntryResolver({ line, guess, onDone }: { line: ReconcileLine; guess: EntryType; onDone: (body: ResolveInput) => void }) {
  const { accounts } = useData()
  const inflow = line.amount_cents > 0
  const [type, setType] = useState<EntryType>(guess)
  const [parts, setParts] = useState<Part[]>([{ date: line.date, amount: amountField(line.amount_cents), description: line.description, category: '' }])
  const [oneOff, setOneOff] = useState(false)
  const remembered = stored(`transfer-target:${line.description.toLowerCase()}`)
  const others = accounts.filter((a) => a.id !== line.account_id && !a.archived)
  const [other, setOther] = useState(others.some((a) => String(a.id) === remembered) ? remembered! : '')
  const [error, setError] = useState('')

  const cents = parts.map((p) => parseAmount(p.amount) ?? 0)
  const left = Math.abs(line.amount_cents) - cents.reduce((n, c) => n + Math.abs(c), 0)
  const setPart = (i: number, patch: Partial<Part>) => setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  function save() {
    setError('')
    if (type === 'ignore') return onDone({ bank_line_id: line.id, action: 'ignore' })
    if (type === 'transfer') {
      if (!other) return setError('Choose the other account')
      store(`transfer-target:${line.description.toLowerCase()}`, other)
      return onDone({ bank_line_id: line.id, action: 'transfer', other_account_id: +other, description: parts[0].description })
    }
    if (left !== 0) return setError(`The parts must add up to ${money(Math.abs(line.amount_cents))}; ${money(Math.abs(left))} ${left > 0 ? 'left to assign' : 'too much'}`)
    onDone({
      bank_line_id: line.id, action: 'entry',
      parts: parts.map((p, i) => ({ kind: type, date: p.date, amount_cents: Math.abs(cents[i]), description: p.description, category_id: type !== 'income' && p.category ? +p.category : null, one_off: oneOff })),
    })
  }

  const types: [EntryType, string][] = inflow
    ? [['reimbursement', 'Reimbursement'], ['income', 'Income'], ['transfer', 'Transfer in'], ['ignore', 'Ignore']]
    : [['purchase', 'Purchase'], ['transfer', 'Transfer out'], ['ignore', 'Ignore']]
  return (
    <div className="resolver">
      <div className="tabs">
        {types.map(([t, label]) => <button key={t} type="button" className={type === t ? 'active' : ''} onClick={() => setType(t)}>{label}</button>)}
      </div>
      {type === 'transfer' && (
        <div className="fields">
          <label>{inflow ? 'From' : 'To'}
            <select value={other} onChange={(e) => setOther(e.target.value)}>
              <option value="">Choose…</option>
              {others.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="grow">Note<input value={parts[0].description} onChange={(e) => setPart(0, { description: e.target.value })} /></label>
        </div>
      )}
      {(type === 'purchase' || type === 'income' || type === 'reimbursement') && (
        <>
          {parts.map((p, i) => (
            <div className="fields" key={i}>
              <label>Date<input type="date" value={p.date} onChange={(e) => setPart(i, { date: e.target.value })} /></label>
              <label className="grow">Description<input value={p.description} onChange={(e) => setPart(i, { description: e.target.value })} /></label>
              {parts.length > 1 && <label>Amount<input className="num" inputMode="decimal" value={p.amount} onChange={(e) => setPart(i, { amount: e.target.value })} /></label>}
              {type !== 'income' && <label>Category<CategorySelect value={p.category} onChange={(v) => setPart(i, { category: v })} label="Category" /></label>}
              {parts.length > 1 && <button type="button" aria-label="Remove part" onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}>×</button>}
            </div>
          ))}
          <div className="row">
            <span className="row">
              {(
                <button type="button" onClick={() => setParts((ps) => {
                  // A new part starts with whatever is not yet assigned.
                  const used = ps.reduce((n, x) => n + Math.abs(parseAmount(x.amount) ?? 0), 0)
                  return [...ps, { date: line.date, amount: amountField(Math.max(0, Math.abs(line.amount_cents) - used)), description: '', category: '' }]
                })}>Split</button>
              )}
              {type !== 'reimbursement' && <label className="check"><input type="checkbox" checked={oneOff} onChange={(e) => setOneOff(e.target.checked)} />One-off</label>}
              {parts.length > 1 && <span className={left === 0 ? 'muted small' : 'error small'}>{left === 0 ? 'Parts add up.' : `${money(Math.abs(left))} ${left > 0 ? 'left to assign' : 'over'}`}</span>}
            </span>
          </div>
        </>
      )}
      <div className="row">
        {error ? <p className="error">{error}</p> : <span />}
        <button type="button" className="primary" onClick={save}>{type === 'ignore' ? 'Ignore this line' : 'Record'}</button>
      </div>
    </div>
  )
}

function LineRow({ line, onChanged }: { line: ReconcileLine; onChanged: () => void }) {
  const [manual, setManual] = useState(false)
  const [error, setError] = useState('')
  const act = async (url: string, body: unknown) => {
    try {
      await api('POST', url, body)
      setError('')
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const p = line.proposal
  const guess: EntryType = p?.kind === 'guess' ? p.type : line.amount_cents > 0 ? 'reimbursement' : 'purchase'
  return (
    <li className={`bankline ${line.status}`}>
      <div className="row head">
        <span className="nowrap muted">{dateLabel(line.date)}</span>
        <span className="grow">{line.description} {line.type && <span className="muted small">{line.type}</span>}</span>
        <span className="num nowrap strong">{signed(line.amount_cents)}</span>
        {line.balance_cents !== null && <span className="num nowrap muted small" title="Balance after this line, per the bank">bal {money(line.balance_cents)}</span>}
        {line.status !== 'open'
          ? <><span className={`tag ${line.status === 'done' ? 'income' : ''}`}>{line.status === 'done' ? '✓ done' : 'ignored'}</span><button type="button" onClick={() => void act('/api/reconcile/undo', { bank_line_id: line.id })}>Undo</button></>
          : <span className="tag oneoff">to do</span>}
      </div>
      {line.status === 'done' && line.txs.length > 0 && (
        <ul className="made">
          {line.card_name && <li className="muted small">Paid {line.card_name}:</li>}
          {line.txs.map((t) => (
            <li key={t.id}>
              <span>{t.description}</span>
              {t.category_name && <span className="cat" style={{ background: t.category_color ?? undefined }}>{t.category_name}</span>}
              {t.kind === 'transfer' && <span className="tag transfer">{t.amount_cents < 0 ? `to ${t.other_account_name}` : `from ${t.other_account_name ?? 'paycheck'}`}</span>}
              <span className="num">{t.kind === 'purchase' ? money(-t.amount_cents) : t.kind === 'transfer' ? money(Math.abs(t.amount_cents)) : `+${money(t.amount_cents)}`}</span>
            </li>
          ))}
        </ul>
      )}
      {line.status === 'open' && p && (
        <>
          {p.kind === 'card' && !manual && <CardResolver line={line} proposal={p} onDone={(b) => void act('/api/reconcile/resolve', b)} />}
          {p.kind === 'existing' && !manual && (
            <div className="resolver row">
              <span className="small">Matches your entry <strong>{p.tx.description || '(no description)'}</strong> from {dateLabel(p.tx.date)}{p.tx.category_name ? ` · ${p.tx.category_name}` : ''}.</span>
              <button type="button" className="primary" onClick={() => void act('/api/reconcile/resolve', { bank_line_id: line.id, action: 'existing', tx_id: p.tx.id })}>That's it</button>
            </div>
          )}
          {(p.kind === 'guess' || manual) && <EntryResolver line={line} guess={guess} onDone={(b) => void act('/api/reconcile/resolve', b)} />}
          {p.kind !== 'guess' && (
            <button type="button" className="linkish small" onClick={() => setManual(!manual)}>{manual ? '← Back to the suggestion' : 'Something else'}</button>
          )}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </li>
  )
}

/** For exports without balances: the closing balance typed from the statement. */
function ClosingBalance({ accountId, month, typed, onSaved }: { accountId: string; month: string; typed: boolean; onSaved: () => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  async function save(e: React.FormEvent) {
    e.preventDefault()
    const cents = parseAmount(value)
    if (cents === null) return setError('Type the closing balance from the statement')
    await api('POST', '/api/snapshots', { rows: [{ account_id: +accountId, date: lastDay(month), balance_cents: cents }] })
    setValue('')
    setError('')
    onSaved()
  }
  return (
    <form className="row closing" onSubmit={save}>
      <input className="num" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Closing balance per statement" aria-label="Closing balance per statement" />
      <button type="submit">{typed ? 'Change' : 'Check'}</button>
      {typed && <button type="button" className="linkish small" onClick={() => void api('DELETE', `/api/snapshots?account_id=${accountId}&date=${lastDay(month)}`).then(onSaved)}>Clear</button>}
      {error && <span className="error small">{error}</span>}
    </form>
  )
}

// ---- Page ----

export function Reconcile({ month: fromRoute }: { month?: string }) {
  const { accounts, reload: reloadData } = useData()
  const checking = accounts.filter((a) => a.type === 'checking' && !a.archived)
  const month = fromRoute ?? stored('last-month') ?? currentMonth()
  const [accountId, setAccountId] = useState(() => String(checking[0]?.id ?? ''))
  const view = useLoad<ReconcileView>(`/api/reconcile/${accountId}/${month}`)
  const cards = useLoad<Card[]>('/api/cards')
  const [showDone, setShowDone] = useState(true)
  useEffect(() => store('last-month', month), [month])
  const refresh = () => { void view.reload(); void cards.reload(); void reloadData() }

  const v = view.data && view.data.month === month && String(view.data.account_id) === accountId ? view.data : null
  const counts = useMemo(() => ({
    open: v?.lines.filter((l) => l.status === 'open').length ?? 0,
    total: v?.lines.length ?? 0,
  }), [v])
  const diff = (a: number, b: number | null) => (b === null ? null : a - b)
  const startDiff = v ? diff(v.start.app_cents, v.start.bank_cents) : null
  const endDiff = v ? diff(v.end.app_cents, v.end.bank_cents) : null

  return (
    <>
      <div className="heading">
        {month > `${MIN_YEAR}-01`
          ? <a className="button" href={`#/reconcile/${shiftMonth(month, -1)}`} aria-label="Previous month">‹</a>
          : <button type="button" disabled aria-label="Previous month">‹</button>}
        <h1>Reconcile {monthLabel(month)}</h1>
        <a className="button" href={`#/reconcile/${shiftMonth(month, 1)}`} aria-label="Next month">›</a>
        <a className="button push" href={`#/month/${month}`}>Back to {monthLabel(month, 'short')}</a>
      </div>
      <LoadFiles cards={cards.data ?? []} onLoaded={refresh} />
      <div className="tabs view" role="tablist" aria-label="Account">
        {checking.map((a) => (
          <button key={a.id} type="button" role="tab" aria-selected={String(a.id) === accountId} className={String(a.id) === accountId ? 'active' : ''} onClick={() => setAccountId(String(a.id))}>{a.name}</button>
        ))}
      </div>
      {v && (
        <>
          <div className="tiles">
            <div className={`tile ${startDiff === 0 ? '' : startDiff === null ? '' : 'warn'}`}>
              <span>Start of {monthLabel(month, 'short')}</span>
              <strong>{money(v.start.app_cents)}</strong>
              <em>{v.start.bank_cents === null ? 'No bank balance in the export' : startDiff === 0 ? '✓ Matches the bank' : `Bank says ${money(v.start.bank_cents)}: earlier months are off by ${money(Math.abs(startDiff!))}`}</em>
            </div>
            <div className={`tile ${endDiff === 0 ? '' : endDiff === null ? '' : 'warn'}`}>
              <span>End of {monthLabel(month, 'short')}</span>
              <strong>{money(v.end.app_cents)}</strong>
              <em>{v.end.bank_cents === null ? 'This export has no balances; type the statement’s closing balance to check' : endDiff === 0 ? '✓ Matches the bank' : `Bank says ${money(v.end.bank_cents)}: off by ${money(Math.abs(endDiff!))}`}</em>
              {(v.end.bank_cents === null || v.end.typed) && <ClosingBalance accountId={accountId} month={month} typed={v.end.typed} onSaved={refresh} />}
            </div>
            <div className="tile">
              <span>Bank lines</span>
              <strong>{counts.total - counts.open} of {counts.total} done</strong>
              <em>{counts.open === 0 ? (counts.total ? 'All accounted for' : 'Load an export to start') : `${counts.open} to do`}</em>
            </div>
          </div>
          <section className="card">
            <div className="row">
              <h2>Bank lines, oldest first</h2>
              <label className="check small"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />Show done</label>
            </div>
            {v.lines.length === 0 && <p className="muted empty">No lines for this account and month yet. Load its export above.</p>}
            <ul className="banklines">
              {v.lines.filter((l) => showDone || l.status === 'open').map((l) => <LineRow key={`${l.id}-${l.status}`} line={l} onChanged={refresh} />)}
            </ul>
          </section>
          {v.unmatched.length > 0 && (
            <section className="card">
              <h2>In the app, not on this statement <span className="muted">({v.unmatched.length})</span></h2>
              <p className="muted small">
                Entries filed under {monthLabel(month)} for this account that no bank line accounts for yet. Once every bank line is done, anything
                left here is usually a duplicate, a typo, or something that belongs in another month.
              </p>
              <TxTable rows={v.unmatched} onChanged={refresh} perAccount withYear />
            </section>
          )}
        </>
      )}
    </>
  )
}
