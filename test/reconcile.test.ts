import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../server/app.ts'
import { openDb } from '../server/db.ts'
import { choosePaid } from '../server/reconcile.ts'
import { parseStatement } from '../shared/statements.ts'
import type { Bootstrap, Card, MonthSummary, ReconcileView } from '../shared/types.ts'

// Shaped like the user's real exports, with made-up values.
const CHASE_CARD = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
09/08/2026,09/08/2026,store,Food & Drink,Sale,-24.15,
09/06/2026,09/07/2026,Payment Thank You-Mobile,,Payment,52.07,
09/07/2026,09/07/2026,store,Education,Sale,-241.12,
09/03/2026,09/06/2026,store,Home,Sale,-29.27,
09/05/2026,09/06/2026,store,Shopping,Sale,-22.80,
`
const CAPITAL_ONE = `Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-09-26,2026-09-26,1111,CAPITAL ONE MOBILE PYMT,Payment/Credit,,100
2026-09-24,2026-09-25,1111,SHOE STORE,Merchandise,,15
2026-09-21,2026-09-22,1111,RALPHS,Merchandise,100,
2026-09-20,2026-09-21,1111,SHOE STORE,Merchandise,15,
2026-09-17,2026-09-17,1111,CAPITAL ONE MOBILE PYMT,Payment/Credit,,20
2026-09-08,2026-09-10,1111,RALPHS,Merchandise,20,
`
// Chase checking rows end with an extra empty column.
const CHASE_CHECKING = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
CREDIT,09/28/2026,VENMO CASHOUT,60.00,ACH_CREDIT,1847.93,,
DEBIT,09/27/2026,CAPITAL ONE MOBILE PMT,-100.00,ACH_DEBIT,1787.93,,
DEBIT,09/18/2026,CAPITAL ONE MOBILE PMT,-20.00,ACH_DEBIT,1887.93,,
CREDIT,09/11/2026,Online Transfer from US Bank,500.00,PARTNERFI_TO_CHASE,1907.93,,
DEBIT,09/08/2026,Payment to Chase card ending in 1234 09/08,-52.07,LOAN_PMT,1407.93,,
DEBIT,9/1/2026,Online Transfer to Fidelity,-40.00,MISC_DEBIT,1460.00,,
`
const US_BANK = `"Date","Transaction","Name","Memo","Amount"
"2026-09-11","DEBIT","ZELLE INSTANT PMT TO SELF","Download from usbank.com.","-500.00"
"2026-09-11","CREDIT","ELECTRONIC DEPOSIT PAYROLL","Download from usbank.com.","2600.00"
"2026-09-08","DEBIT","WEB AUTHORIZED PMT VENMO","Download from usbank.com.","-30.00"
`

test('each export format is recognised and read with the right signs', () => {
  const card = parseStatement(CHASE_CARD)
  assert.ok(!('error' in card) && card.kind === 'card' && card.format === 'chase-card')
  assert.deepEqual(card.lines.map((l) => [l.date, l.kind, l.amount_cents]), [
    ['2026-09-03', 'charge', 2927], ['2026-09-05', 'charge', 2280], ['2026-09-06', 'payment', -5207],
    ['2026-09-07', 'charge', 24112], ['2026-09-08', 'charge', 2415],
  ])
  // Two "store" lines on different days stay distinct.
  assert.equal(new Set(card.lines.map((l) => l.fingerprint)).size, 5)

  const c1 = parseStatement(CAPITAL_ONE)
  assert.ok(!('error' in c1) && c1.kind === 'card')
  assert.deepEqual(c1.lines.map((l) => [l.description, l.kind, l.amount_cents, l.last4]), [
    ['RALPHS', 'charge', 2000, '1111'], ['CAPITAL ONE MOBILE PYMT', 'payment', -2000, '1111'], ['SHOE STORE', 'charge', 1500, '1111'],
    ['RALPHS', 'charge', 10000, '1111'], ['SHOE STORE', 'refund', -1500, '1111'], ['CAPITAL ONE MOBILE PYMT', 'payment', -10000, '1111'],
  ])

  const checking = parseStatement(CHASE_CHECKING)
  assert.ok(!('error' in checking) && checking.kind === 'bank' && checking.format === 'chase-checking')
  assert.deepEqual(checking.lines[0], {
    date: '2026-09-01', description: 'Online Transfer to Fidelity', amount_cents: -4000, type: 'MISC_DEBIT', balance_cents: 146000,
    fingerprint: checking.lines[0].fingerprint,
  })

  const us = parseStatement(US_BANK)
  assert.ok(!('error' in us) && us.kind === 'bank' && us.format === 'usbank-checking')
  assert.deepEqual(us.lines.map((l) => [l.date, l.amount_cents, l.balance_cents]), [['2026-09-08', -3000, null], ['2026-09-11', 260000, null], ['2026-09-11', -50000, null]])

  assert.ok('error' in parseStatement('a,b,c\n1,2,3'))
})

test('a payment covers the oldest unpaid lines, skipping one if needed', () => {
  assert.deepEqual(choosePaid([2927, 2280, 24112], 5207), { picked: new Set([0, 1]), exact: true })
  assert.deepEqual(choosePaid([1000, 500, 300], 1300), { picked: new Set([0, 2]), exact: true })
  assert.deepEqual(choosePaid([1000, 500], 1200), { picked: new Set([0]), exact: false })
})

function setup() {
  const app = createApp(openDb(':memory:'))
  const call = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const res = await app.request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const json = await res.json()
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`)
    return json as T
  }
  return call
}

async function loaded() {
  const call = setup()
  const boot = await call<Bootstrap>('GET', '/api/bootstrap')
  const account = (name: string) => boot.accounts.find((a) => a.name === name)!.id
  const category = (name: string) => boot.categories.find((c) => c.name === name)!.id
  const chaseCard = await call<Card>('POST', '/api/cards', { name: 'Chase Freedom', issuer: 'chase', last4: '1234' })
  const capOne = await call<Card>('POST', '/api/cards', { name: 'Capital One', issuer: 'capitalone', last4: '1111' })
  const lines = (text: string) => (parseStatement(text) as { lines: unknown[] }).lines
  await call('POST', '/api/statements', { kind: 'card', card_id: chaseCard.id, lines: lines(CHASE_CARD) })
  await call('POST', '/api/statements', { kind: 'card', card_id: capOne.id, lines: lines(CAPITAL_ONE) })
  const first = await call<{ added: number; already: number }>('POST', '/api/statements', { kind: 'bank', account_id: account('Chase'), lines: lines(CHASE_CHECKING) })
  assert.deepEqual(first, { added: 6, already: 0 })
  // Loading an overlapping export again adds nothing.
  assert.deepEqual(await call('POST', '/api/statements', { kind: 'bank', account_id: account('Chase'), lines: lines(CHASE_CHECKING) }), { added: 0, already: 6 })
  const view = () => call<ReconcileView>('GET', `/api/reconcile/${account('Chase')}/2026-09`)
  return { call, account, category, view }
}

test('card payments are proposed with the card lines they paid, refunds included', async () => {
  const { view } = await loaded()
  const v = await view()
  assert.deepEqual(v.lines.map((l) => [l.description, l.proposal?.kind]), [
    ['Online Transfer to Fidelity', 'guess'], ['Payment to Chase card ending in 1234 09/08', 'card'], ['Online Transfer from US Bank', 'guess'],
    ['CAPITAL ONE MOBILE PMT', 'card'], ['CAPITAL ONE MOBILE PMT', 'card'], ['VENMO CASHOUT', 'guess'],
  ])
  const chase = v.lines[1].proposal
  assert.ok(chase?.kind === 'card' && chase.exact)
  assert.deepEqual(chase.items.filter((i) => i.proposed).map((i) => [i.date, i.amount_cents]), [['2026-09-03', 2927], ['2026-09-05', 2280]])
  // $100 Capital One payment: Ralphs 100 + shoes 15 - shoe refund 15, once the $20 payment has its own Ralphs.
  const cap100 = v.lines[4].proposal
  assert.ok(cap100?.kind === 'card' && cap100.payment.amount_cents === -10000)
  assert.deepEqual(v.start, { app_cents: 0, bank_cents: 150000 })
  assert.deepEqual(v.end, { app_cents: 0, bank_cents: 184793, typed: false })
})

test('resolving a whole month: card payments, split Venmo, transfers, then the balances agree', async () => {
  const { call, account, category, view } = await loaded()
  await call('PATCH', `/api/accounts/${account('Chase')}`, { opening_cents: 150000 })
  let v = await view()
  const byDesc = (d: string, n = 0) => v.lines.filter((l) => l.description === d)[n]

  // Fidelity and US Bank transfers.
  await call('POST', '/api/reconcile/resolve', { bank_line_id: byDesc('Online Transfer to Fidelity').id, action: 'transfer', other_account_id: account('Fidelity'), description: '' })
  await call('POST', '/api/reconcile/resolve', { bank_line_id: byDesc('Online Transfer from US Bank').id, action: 'transfer', other_account_id: account('US Bank'), description: 'Zelle' })

  // Chase card payment, with a category chosen for one line.
  const chaseLine = byDesc('Payment to Chase card ending in 1234 09/08')
  const p = chaseLine.proposal!
  assert.ok(p.kind === 'card')
  await call('POST', '/api/reconcile/resolve', {
    bank_line_id: chaseLine.id, action: 'card', card_payment_id: p.payment.id,
    items: p.items.filter((i) => i.proposed).map((i, n) => ({ card_line_id: i.id, category_id: n === 0 ? category('Shopping') : null, existing_tx_id: null })),
  })

  // The $20 Capital One payment first (it is dated first), then refresh and do the $100.
  v = await view()
  for (const n of [0, 1]) {
    const line = byDesc('CAPITAL ONE MOBILE PMT', n)
    const prop = line.proposal!
    assert.ok(prop.kind === 'card' && prop.exact, `payment ${n} adds up`)
    await call('POST', '/api/reconcile/resolve', {
      bank_line_id: line.id, action: 'card', card_payment_id: prop.payment.id,
      items: prop.items.filter((i) => i.proposed).map((i) => ({ card_line_id: i.id, category_id: null, existing_tx_id: null })),
    })
    v = await view()
  }

  // Venmo split: $25 dinner and $35 tickets.
  await call('POST', '/api/reconcile/resolve', {
    bank_line_id: byDesc('VENMO CASHOUT').id, action: 'entry', parts: [
      { kind: 'reimbursement', amount_cents: 2500, description: 'Dinner', category_id: category('Food') },
      { kind: 'reimbursement', amount_cents: 3500, description: 'Tickets', category_id: category('Shopping') },
    ],
  })
  // A split that does not add up is refused.
  await assert.rejects(call('POST', '/api/reconcile/resolve', { bank_line_id: byDesc('VENMO CASHOUT').id, action: 'ignore' }), /already accounted/)

  v = await view()
  assert.ok(v.lines.every((l) => l.status === 'done'))
  assert.equal(v.end.app_cents, v.end.bank_cents)
  assert.deepEqual(v.unmatched.map((t) => t.description), ['Zelle'].filter(() => false))

  // Every card line kept its real price; the refund is linked to the shoes it reverses.
  const shoes = v.lines.flatMap((l) => l.txs).filter((t) => t.description === 'SHOE STORE')
  assert.deepEqual(shoes.map((t) => [t.kind, t.amount_cents, !!t.reimburses_id]), [['purchase', -1500, false], ['reimbursement', 1500, true]])
  const sep = await call<MonthSummary>('GET', '/api/month/2026-09')
  assert.equal(sep.spending_cents, 2927 + 2280 + 2000 + 10000 + 1500 - 1500 - 6000)

  // Undo the Chase card payment: its entries go and the card lines are free again.
  await call('POST', '/api/reconcile/undo', { bank_line_id: chaseLine.id })
  v = await view()
  const reopened = v.lines.find((l) => l.id === chaseLine.id)!
  assert.equal(reopened.status, 'open')
  assert.ok(reopened.proposal?.kind === 'card' && reopened.proposal.exact)
  assert.equal(v.end.app_cents, v.end.bank_cents! + 5207)
})

test('purchases already typed in by hand are matched instead of added again', async () => {
  const { call, account, category, view } = await loaded()
  const typed = await call<{ id: number }>('POST', '/api/transactions', { kind: 'purchase', date: '2026-09-04', month: '2026-09', account_id: account('Chase'), amount_cents: 2927, description: 'Lamp', category_id: category('Shopping') })
  const v = await view()
  const line = v.lines.find((l) => l.type === 'LOAN_PMT')!
  const p = line.proposal!
  assert.ok(p.kind === 'card')
  const lamp = p.items.find((i) => i.amount_cents === 2927)!
  assert.equal(lamp.existing?.id, typed.id)
  await call('POST', '/api/reconcile/resolve', {
    bank_line_id: line.id, action: 'card', card_payment_id: p.payment.id,
    items: p.items.filter((i) => i.proposed).map((i) => ({ card_line_id: i.id, category_id: null, existing_tx_id: i.existing?.id ?? null })),
  })
  const after = await view()
  const txs = after.lines.find((l) => l.id === line.id)!.txs
  assert.deepEqual(txs.map((t) => [t.description, t.category_name]), [['Lamp', 'Shopping'], ['store', null]])
  // Undo only unlinks the typed one.
  await call('POST', '/api/reconcile/undo', { bank_line_id: line.id })
  const listed = await call<{ rows: { description: string }[] }>('GET', '/api/transactions?month=2026-09')
  assert.deepEqual(listed.rows.map((r) => r.description), ['Lamp'])
})

test('charges paid by an earlier payment are not offered again, even when that month was never reconciled', async () => {
  const call = setup()
  const boot = await call<Bootstrap>('GET', '/api/bootstrap')
  const chase = boot.accounts.find((a) => a.name === 'Chase')!.id
  const card = await call<Card>('POST', '/api/cards', { name: 'Chase Freedom', issuer: 'chase', last4: '1234' })
  // The card export reaches back into August; August's charges were paid in August.
  const cardCsv = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
08/20/2026,08/21/2026,August shoes,Shopping,Sale,-80.00,
08/25/2026,08/26/2026,August dinner,Food & Drink,Sale,-20.00,
08/28/2026,08/28/2026,Payment Thank You-Mobile,,Payment,100.00,
09/03/2026,09/04/2026,September lunch,Food & Drink,Sale,-15.00,
09/10/2026,09/11/2026,September books,Shopping,Sale,-35.00,
09/12/2026,09/12/2026,Payment Thank You-Mobile,,Payment,50.00,
`
  const checkingCsv = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,09/12/2026,Payment to Chase card ending in 1234 09/12,-50.00,LOAN_PMT,950.00,,
`
  const lines = (text: string) => (parseStatement(text) as { lines: unknown[] }).lines
  await call('POST', '/api/statements', { kind: 'card', card_id: card.id, lines: lines(cardCsv) })
  await call('POST', '/api/statements', { kind: 'bank', account_id: chase, lines: lines(checkingCsv) })
  const v = await call<ReconcileView>('GET', `/api/reconcile/${chase}/2026-09`)
  const p = v.lines[0].proposal
  assert.ok(p?.kind === 'card' && p.exact)
  assert.deepEqual(p.items.map((i) => i.description), ['September lunch', 'September books'])
})

test('a card payment the export cannot explain can be made up with lines typed in, each with its own date', async () => {
  const call = setup()
  const boot = await call<Bootstrap>('GET', '/api/bootstrap')
  const chase = boot.accounts.find((a) => a.name === 'Chase')!.id
  const card = await call<Card>('POST', '/api/cards', { name: 'Chase Freedom', issuer: 'chase', last4: '1234' })
  const lines = (text: string) => (parseStatement(text) as { lines: unknown[] }).lines
  // The export starts after the charges this payment covered.
  await call('POST', '/api/statements', { kind: 'card', card_id: card.id, lines: lines(`Transaction Date,Post Date,Description,Category,Type,Amount,Memo
09/05/2026,09/05/2026,Payment Thank You-Mobile,,Payment,55.27,
09/09/2026,09/09/2026,Later,Food & Drink,Sale,-10.00,
`) })
  await call('POST', '/api/statements', { kind: 'bank', account_id: chase, lines: lines(`Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
CREDIT,09/20/2026,VENMO CASHOUT,30.00,ACH_CREDIT,974.73,,
DEBIT,09/05/2026,Payment to Chase card ending in 1234 09/05,-55.27,LOAN_PMT,944.73,,
`) })
  let v = await call<ReconcileView>('GET', `/api/reconcile/${chase}/2026-09`)
  const pay = v.lines.find((l) => l.type === 'LOAN_PMT')!
  assert.ok(pay.proposal?.kind === 'card' && !pay.proposal.exact)
  const body = { bank_line_id: pay.id, action: 'card', card_payment_id: pay.proposal.payment.id, items: [] }
  await assert.rejects(call('POST', '/api/reconcile/resolve', { ...body, manual: [{ date: '2026-08-30', description: 'Groceries', amount_cents: 5000, category_id: null }] }), /add up to 50.00/)
  await call('POST', '/api/reconcile/resolve', { ...body, manual: [
    { date: '2026-08-30', description: 'Groceries', amount_cents: 6000, category_id: null },
    { date: '2026-09-01', description: 'Return', amount_cents: -473, category_id: null },
  ] })
  // Venmo split with a date for each part.
  const venmo = v.lines.find((l) => l.description === 'VENMO CASHOUT')!
  await call('POST', '/api/reconcile/resolve', { bank_line_id: venmo.id, action: 'entry', parts: [
    { kind: 'reimbursement', amount_cents: 1000, description: 'Lunch', category_id: null, date: '2026-09-02' },
    { kind: 'reimbursement', amount_cents: 2000, description: 'Movie', category_id: null, date: '2026-09-15' },
  ] })
  v = await call<ReconcileView>('GET', `/api/reconcile/${chase}/2026-09`)
  assert.deepEqual(v.lines.flatMap((l) => l.txs).map((t) => [t.description, t.date, t.month, t.amount_cents]), [
    ['Groceries', '2026-08-30', '2026-09', -6000], ['Return', '2026-09-01', '2026-09', 473],
    ['Lunch', '2026-09-02', '2026-09', 1000], ['Movie', '2026-09-15', '2026-09', 2000],
  ])
})
