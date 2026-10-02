import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp, merchantFor } from '../server/app.ts'
import { openDb } from '../server/db.ts'
import { guessRoles, parseAmount, parseDate, parseRows, splitRows } from '../shared/parse.ts'
import type { Bootstrap, MerchantGroup, MonthSummary, NetWorth, Tx, YearSummary } from '../shared/types.ts'

function setup() {
  const app = createApp(openDb(':memory:'))
  const call = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const res = await app.request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`)
    return json as T
  }
  return { app, call }
}

async function ids(call: ReturnType<typeof setup>['call']) {
  const boot = await call<Bootstrap>('GET', '/api/bootstrap')
  const account = (name: string) => boot.accounts.find((a) => a.name === name)!.id
  const category = (name: string) => boot.categories.find((c) => c.name === name)!.id
  return { account, category }
}

test('parseAmount', () => {
  assert.equal(parseAmount('$1,234.56'), 123456)
  assert.equal(parseAmount('(12.00)'), -1200)
  assert.equal(parseAmount('-5'), -500)
  assert.equal(parseAmount('19.99'), 1999)
  assert.equal(parseAmount('.5'), 50)
  assert.equal(parseAmount('Food'), null)
  assert.equal(parseAmount(''), null)
})

test('parseDate', () => {
  assert.equal(parseDate('2026-01-15', 2026), '2026-01-15')
  assert.equal(parseDate('1/15/2026', 2025), '2026-01-15')
  assert.equal(parseDate('1/15/26', 2025), '2026-01-15')
  assert.equal(parseDate('1/15', 2026), '2026-01-15')
  assert.equal(parseDate('Jan 15', 2026), '2026-01-15')
  assert.equal(parseDate('January 15, 2026', 2025), '2026-01-15')
  assert.equal(parseDate('15 Jan 2026', 2025), '2026-01-15')
  assert.equal(parseDate('46024', 2026), '2026-01-02')
  assert.equal(parseDate('2/30/2026', 2026), null)
  assert.equal(parseDate('Food', 2026), null)
})

test('pasted spending block: roles are guessed, blanks and headers dropped, aliases applied', () => {
  const categories = [{ id: 1, name: 'Food' }, { id: 2, name: 'Shopping' }, { id: 3, name: 'Subscriptions' }]
  const text = [
    'Spending\tAmount\tDate\tCategory',
    'Cafe\t$4.50\t1/3/2026\tFood',
    'Gym\t40\t1/5/2026\tExercise',
    '\t\t\tFood',
    'Mystery\t12\t\tFood',
    'Thing\t9.00\t1/9/2026\tGadgets',
  ].join('\n')
  const rows = splitRows(text)
  const roles = guessRoles(rows, categories, 2026)
  assert.deepEqual(roles, ['description', 'amount', 'date', 'category'])
  const { parsed, skipped } = parseRows(rows, roles, categories, 2026)
  assert.equal(skipped, 2)
  assert.deepEqual(parsed.map((r) => [r.description, r.amount_cents, r.date, r.category_id]), [
    ['Cafe', 450, '2026-01-03', 1],
    ['Gym', 4000, '2026-01-05', 3],
    ['Mystery', 1200, null, 1],
    ['Thing', 900, '2026-01-09', null],
  ])
  assert.deepEqual(parsed[2].errors, ['missing date'])
  assert.equal(parsed[3].errors.length, 0)
  assert.equal(parsed[3].warnings.length, 1)
})

test('CSV with quoted commas', () => {
  assert.deepEqual(splitRows('01/02/2026,"ACME, INC",-12.50'), [['01/02/2026', 'ACME, INC', '-12.50']])
})

test('a linked reimbursement lowers the month and category of the original purchase', async () => {
  const { call } = setup()
  const { account, category } = await ids(call)
  const shirt = await call<Tx>('POST', '/api/transactions', {
    kind: 'purchase', date: '2026-08-20', account_id: account('Chase'), amount_cents: 5000, description: 'Shirt', category_id: category('Shopping'),
  })
  await call('POST', '/api/transactions', {
    kind: 'purchase', date: '2026-09-02', account_id: account('Chase'), amount_cents: 2000, description: 'Lunch', category_id: category('Food'),
  })
  // Returned in September.
  await call('POST', '/api/transactions', {
    kind: 'reimbursement', date: '2026-09-10', account_id: account('Chase'), amount_cents: 5000, description: 'Shirt return', category_id: null, reimburses_id: shirt.id,
  })
  // A friend paying back half of lunch, not linked to anything.
  await call('POST', '/api/transactions', {
    kind: 'reimbursement', date: '2026-09-12', account_id: account('Chase'), amount_cents: 1000, description: 'Friend Venmo', category_id: category('Food'),
  })

  const aug = await call<MonthSummary>('GET', '/api/month/2026-08')
  const sep = await call<MonthSummary>('GET', '/api/month/2026-09')
  assert.equal(aug.spending_cents, 0)
  assert.equal(sep.spending_cents, 1000)
  assert.deepEqual(sep.categories.map((c) => [c.name, c.cents]), [['Food', 1000]])

  // The checking balance still follows when the money actually moved.
  assert.equal(aug.accounts.find((a) => a.name === 'Chase')!.balance_cents, -5000)
  assert.equal(sep.accounts.find((a) => a.name === 'Chase')!.balance_cents, -1000)

  const listed = await call<{ rows: Tx[] }>('GET', '/api/transactions?from=2026-08-01&to=2026-08-31')
  assert.equal(listed.rows[0].reimbursed_cents, 5000)
})

test('transfers are not spending, and moves between savings accounts are not new savings', async () => {
  const { call } = setup()
  const { account, category } = await ids(call)
  await call('POST', '/api/transactions', { kind: 'income', date: '2026-03-01', account_id: account('Chase'), amount_cents: 300000, description: 'Paycheck', category_id: null })
  await call('POST', '/api/transactions', { kind: 'purchase', date: '2026-03-05', account_id: account('Chase'), amount_cents: 12000, description: 'Groceries', category_id: category('Groceries') })
  await call('POST', '/api/transfers', { date: '2026-04-02', from_account_id: account('US Bank'), to_account_id: account('Chase'), amount_cents: 12000, description: 'Zelle' })
  await call('POST', '/api/transfers', { date: '2026-03-10', from_account_id: account('Chase'), to_account_id: account('Marcus'), amount_cents: 50000, description: '' })
  await call('POST', '/api/transfers', { date: '2026-03-20', from_account_id: account('Marcus'), to_account_id: account('Bread'), amount_cents: 20000, description: '' })
  await call('POST', '/api/transfers', { date: '2026-03-15', from_account_id: null, to_account_id: account('401k'), amount_cents: 40000, description: 'Payroll' })

  const mar = await call<MonthSummary>('GET', '/api/month/2026-03')
  assert.equal(mar.income_cents, 300000)
  assert.equal(mar.spending_cents, 12000)
  assert.deepEqual(mar.moved, { savings: 50000, investment: 0, retirement: 40000 })
  assert.equal(mar.accounts.find((a) => a.name === 'Chase')!.balance_cents, 238000)

  // A Zelle between the checking accounts in April is not spending or income.
  const apr = await call<MonthSummary>('GET', '/api/month/2026-04')
  assert.equal(apr.spending_cents, 0)
  assert.equal(apr.income_cents, 0)
  assert.equal(apr.accounts.find((a) => a.name === 'Chase')!.balance_cents, 250000)
  assert.equal(apr.accounts.find((a) => a.name === 'US Bank')!.balance_cents, -12000)
  assert.deepEqual(apr.accounts.map((a) => a.name), ['Chase', 'US Bank'])

  const year = await call<YearSummary>('GET', '/api/year/2026')
  assert.equal(year.contributions.find((a) => a.name === 'Marcus')!.cents[2], 30000)
  assert.equal(year.contributions.find((a) => a.name === 'Bread')!.cents[2], 20000)
  assert.equal(year.income[2], 300000)

  // Without an account filter each transfer lists once.
  const all = await call<{ rows: Tx[] }>('GET', '/api/transactions')
  assert.equal(all.rows.filter((r) => r.kind === 'transfer').length, 4)
})

test('editing or deleting one side of a transfer changes both', async () => {
  const { call } = setup()
  const { account } = await ids(call)
  const leg = await call<Tx>('POST', '/api/transfers', { date: '2026-05-01', from_account_id: account('US Bank'), to_account_id: account('Chase'), amount_cents: 10000, description: 'Zelle' })
  await call('PATCH', `/api/transactions/${leg.id}`, { amount_cents: 15000, date: '2026-05-02' })
  let may = await call<MonthSummary>('GET', '/api/month/2026-05')
  assert.equal(may.accounts.find((a) => a.name === 'US Bank')!.balance_cents, -15000)
  assert.equal(may.accounts.find((a) => a.name === 'Chase')!.balance_cents, 15000)
  await call('DELETE', `/api/transactions/${leg.id}`)
  may = await call<MonthSummary>('GET', '/api/month/2026-05')
  assert.equal(may.accounts.find((a) => a.name === 'Chase')!.balance_cents, 0)
})

test('one-off purchases are kept out of regular spending', async () => {
  const { call } = setup()
  const { account, category } = await ids(call)
  await call('POST', '/api/transactions', { kind: 'purchase', date: '2026-02-10', account_id: account('Chase'), amount_cents: 59900, description: '2025 Taxes', category_id: null, one_off: true })
  await call('POST', '/api/transactions', { kind: 'purchase', date: '2026-02-11', account_id: account('Chase'), amount_cents: 1000, description: 'Bus', category_id: category('Transportation') })
  const feb = await call<MonthSummary>('GET', '/api/month/2026-02')
  assert.equal(feb.spending_cents, 1000)
  assert.equal(feb.one_off_cents, 59900)
  const year = await call<YearSummary>('GET', '/api/year/2026')
  assert.equal(year.one_off[1], 59900)
})

test('pasting the same rows twice adds nothing, but genuine repeats are kept', async () => {
  const { call } = setup()
  const { account, category } = await ids(call)
  const coffee = { kind: 'purchase', date: '2026-01-03', account_id: account('Chase'), amount_cents: 450, description: 'Cafe', category_id: category('Food') }
  assert.deepEqual(await call('POST', '/api/import', { rows: [coffee, coffee] }), { inserted: 2, skipped: 0, moved: 0 })
  assert.deepEqual(await call('POST', '/api/import', { rows: [coffee, coffee] }), { inserted: 0, skipped: 2, moved: 0 })
  assert.deepEqual(await call('POST', '/api/import', { rows: [coffee, coffee, coffee] }), { inserted: 1, skipped: 2, moved: 0 })
})

test('reconciliation compares a recorded bank balance with the closing balance of its month', async () => {
  const { call } = setup()
  const { account } = await ids(call)
  await call('PATCH', `/api/accounts/${account('Chase')}`, { opening_cents: 13820 })
  await call('POST', '/api/transactions', { kind: 'income', date: '2026-01-02', account_id: account('Chase'), amount_cents: 100000, description: 'Pay', category_id: null })
  await call('POST', '/api/transactions', { kind: 'purchase', date: '2026-01-30', account_id: account('Chase'), amount_cents: 2000, description: 'Late', category_id: null })
  await call('POST', '/api/snapshots', { rows: [{ account_id: account('Chase'), date: '2026-01-15', balance_cents: 113000 }] })
  const jan = await call<MonthSummary>('GET', '/api/month/2026-01')
  const chase = jan.accounts.find((a) => a.name === 'Chase')!
  assert.equal(chase.balance_cents, 111820)
  assert.deepEqual(chase.snapshot, { date: '2026-01-15', balance_cents: 113000, computed_cents: 111820 })
})

test('companies group by rule, then by typed text, and net linked refunds', async () => {
  const { call } = setup()
  const { account, category } = await ids(call)
  const buy = (description: string, cents: number, date = '2026-06-01') =>
    call<Tx>('POST', '/api/transactions', { kind: 'purchase', date, account_id: account('US Bank'), amount_cents: cents, description, category_id: category('Shopping') })
  await buy('AMZN Mktp', 3000)
  const order = await buy('Amazon.com order', 2000)
  await buy('Trader Joes #552', 1500)
  await buy('trader joes', 500)
  await call('POST', '/api/transactions', { kind: 'reimbursement', date: '2026-07-01', account_id: account('US Bank'), amount_cents: 2000, description: 'refund', category_id: null, reimburses_id: order.id })
  await call('POST', '/api/rules', { pattern: 'amzn|amazon', is_regex: 1, merchant: 'Amazon' })
  const groups = await call<MerchantGroup[]>('GET', '/api/merchants')
  assert.deepEqual(groups.map((g) => [g.merchant, g.cents, g.count, g.matched_rule]), [
    ['Amazon', 3000, 2, true],
    ['trader joes', 2000, 2, false],
  ])
  assert.deepEqual(merchantFor('anything', [{ id: 1, pattern: '(', is_regex: 1, merchant: 'Broken' }]), { merchant: 'anything', matched: false })
})

test('net worth carries each account forward at its latest balance', async () => {
  const { call } = setup()
  const { account } = await ids(call)
  await call('POST', '/api/snapshots', { rows: [
    { account_id: account('Fidelity'), date: '2026-01-28', balance_cents: 100000 },
    { account_id: account('401k'), date: '2026-01-28', balance_cents: 200000 },
    { account_id: account('Fidelity'), date: '2026-02-28', balance_cents: 150000 },
  ] })
  await call('POST', '/api/goals', { name: 'House', target_cents: 1000000, target_date: '2028-01-01', account_ids: [account('Fidelity')] })
  const nw = await call<NetWorth>('GET', '/api/networth')
  assert.deepEqual(nw.series, [
    { date: '2026-01-28', total: 300000, non_retirement: 100000 },
    { date: '2026-02-28', total: 350000, non_retirement: 150000 },
  ])
  assert.equal(nw.goals[0].current_cents, 150000)
})

test('bad input is rejected with a message', async () => {
  const { app } = setup()
  const res = await app.request('/api/transactions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'purchase', date: 'yesterday', account_id: 1, amount_cents: 100, description: '' }),
  })
  assert.equal(res.status, 400)
})

test('opening an older database removes unused card accounts and hides used ones', async () => {
  const db = openDb(':memory:')
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Card 1', 'card'), ('Card 2', 'card')`)
  const used = (db.prepare(`SELECT id FROM accounts WHERE name = 'Card 2'`).get() as { id: number }).id
  db.prepare(`INSERT INTO transactions (date, account_id, amount_cents, kind) VALUES ('2026-01-01', ?, -100, 'purchase')`).run(used)
  // openDb runs the same clean-up on every start; run it again against this data.
  const file = `${process.env.TMPDIR ?? '/tmp/'}spend-test-${process.pid}.sqlite`
  await db.backup(file)
  const reopened = openDb(file)
  const cards = reopened.prepare(`SELECT name, archived FROM accounts WHERE type = 'card'`).all()
  assert.deepEqual(cards, [{ name: 'Card 2', archived: 1 }])
  reopened.close()
  for (const suffix of ['', '-wal', '-shm']) (await import('node:fs')).rmSync(file + suffix, { force: true })
})

test('bulk contributions: checking pays for savings, a paycheck 401k touches no checking account, re-paste adds nothing', async () => {
  const { call } = setup()
  const { account } = await ids(call)
  const rows = [
    { date: '2026-01-02', from_account_id: account('Chase'), to_account_id: account('WAB HYSA'), amount_cents: 10000, description: '' },
    { date: '2026-01-02', from_account_id: null, to_account_id: account('401k'), amount_cents: 60000, description: '' },
    { date: '2026-01-16', from_account_id: null, to_account_id: account('401k'), amount_cents: 60000, description: '' },
  ]
  assert.deepEqual(await call('POST', '/api/import-transfers', { rows }), { inserted: 3, skipped: 0, moved: 0 })
  assert.deepEqual(await call('POST', '/api/import-transfers', { rows }), { inserted: 0, skipped: 3, moved: 0 })
  const jan = await call<MonthSummary>('GET', '/api/month/2026-01')
  assert.deepEqual(jan.moved, { savings: 10000, investment: 0, retirement: 120000 })
  assert.equal(jan.income_cents, 0)
  assert.deepEqual(jan.accounts.map((a) => [a.name, a.balance_cents]), [['Chase', -10000], ['US Bank', 0]])
})

test('an entry counts in the month it is filed under, whatever its date', async () => {
  const { call } = setup()
  const { account, category } = await ids(call)
  // Bought on the card in late December, paid from checking in January.
  const dec = { kind: 'purchase', date: '2025-12-28', account_id: account('Chase'), amount_cents: 4000, description: 'Gift', category_id: category('Shopping') }
  await call('POST', '/api/transactions', { ...dec, month: '2026-01' })
  await call('POST', '/api/transactions', { kind: 'income', date: '2026-01-02', account_id: account('Chase'), amount_cents: 100000, description: 'Pay', category_id: null })
  // Bought in late January, paid in February.
  await call('POST', '/api/transactions', { kind: 'purchase', date: '2026-01-30', month: '2026-02', account_id: account('Chase'), amount_cents: 2500, description: 'Dinner', category_id: category('Food') })

  const before = await call<MonthSummary>('GET', '/api/month/2025-12')
  const jan = await call<MonthSummary>('GET', '/api/month/2026-01')
  const feb = await call<MonthSummary>('GET', '/api/month/2026-02')
  assert.equal(before.spending_cents, 0)
  assert.equal(before.accounts[0].balance_cents, 0)
  assert.equal(jan.spending_cents, 4000)
  assert.equal(jan.accounts[0].balance_cents, 96000)
  assert.equal(feb.spending_cents, 2500)
  assert.equal(feb.accounts[0].balance_cents, 93500)

  const listed = await call<{ rows: Tx[] }>('GET', '/api/transactions?month=2026-01')
  assert.deepEqual(listed.rows.map((r) => [r.description, r.date, r.month]), [['Pay', '2026-01-02', '2026-01'], ['Gift', '2025-12-28', '2026-01']])
  const year = await call<YearSummary>('GET', '/api/year/2026')
  assert.deepEqual(year.categories.find((c) => c.name === 'Shopping')!.cents.slice(0, 2), [4000, 0])

  // Without a month, the date decides. Re-pasting with a month moves the existing row instead of doubling it.
  const late = { kind: 'purchase', date: '2026-02-27', account_id: account('Chase'), amount_cents: 900, description: 'Taxi', category_id: null }
  assert.deepEqual(await call('POST', '/api/import', { rows: [late] }), { inserted: 1, skipped: 0, moved: 0 })
  assert.deepEqual(await call('POST', '/api/import', { rows: [{ ...late, month: '2026-03' }] }), { inserted: 0, skipped: 0, moved: 1 })
  assert.equal((await call<MonthSummary>('GET', '/api/month/2026-02')).spending_cents, 2500)
  assert.equal((await call<MonthSummary>('GET', '/api/month/2026-03')).spending_cents, 900)

  // Changing a date later leaves the entry in its month; the month is changed on its own.
  const gift = listed.rows[1]
  await call('PATCH', `/api/transactions/${gift.id}`, { date: '2025-12-20' })
  assert.equal((await call<MonthSummary>('GET', '/api/month/2026-01')).spending_cents, 4000)
  await call('PATCH', `/api/transactions/${gift.id}`, { month: '2025-12' })
  assert.equal((await call<MonthSummary>('GET', '/api/month/2026-01')).spending_cents, 0)
})

test('one-off income is kept out of regular income but still lands in the balance', async () => {
  const { call } = setup()
  const { account } = await ids(call)
  await call('POST', '/api/transactions', { kind: 'income', date: '2026-04-01', account_id: account('Chase'), amount_cents: 300000, description: 'Paycheck', category_id: null })
  const refund = await call<Tx>('POST', '/api/transactions', { kind: 'income', date: '2026-04-10', account_id: account('Chase'), amount_cents: 80000, description: 'Tax refund', category_id: null })
  let apr = await call<MonthSummary>('GET', '/api/month/2026-04')
  assert.equal(apr.income_cents, 380000)
  // Tagged afterwards, as when going back over old entries.
  await call('PATCH', `/api/transactions/${refund.id}`, { one_off: true })
  apr = await call<MonthSummary>('GET', '/api/month/2026-04')
  assert.equal(apr.income_cents, 300000)
  assert.equal(apr.one_off_income_cents, 80000)
  assert.equal(apr.accounts[0].balance_cents, 380000)
  const year = await call<YearSummary>('GET', '/api/year/2026')
  assert.equal(year.income[3], 300000)
  assert.equal(year.one_off_income[3], 80000)
  const listed = await call<{ rows: Tx[] }>('GET', '/api/transactions?kind=income&one_off=1')
  assert.deepEqual(listed.rows.map((r) => r.description), ['Tax refund'])
})

test('paycheck deductions are reported apart from contributions out of take-home pay', async () => {
  const { call } = setup()
  const { account } = await ids(call)
  await call('POST', '/api/transfers', { date: '2026-01-15', from_account_id: null, to_account_id: account('401k'), amount_cents: 60000, description: '' })
  await call('POST', '/api/transfers', { date: '2026-01-20', from_account_id: account('Chase'), to_account_id: account('Roth IRA'), amount_cents: 50000, description: '' })
  const year = await call<YearSummary>('GET', '/api/year/2026')
  const k = year.contributions.find((a) => a.name === '401k')!
  const roth = year.contributions.find((a) => a.name === 'Roth IRA')!
  assert.deepEqual([k.cents[0], k.paycheck[0]], [60000, 60000])
  assert.deepEqual([roth.cents[0], roth.paycheck[0]], [50000, 0])
})

test('an older database with a Roth 401k account has it folded into 401k', async () => {
  const file = `${process.env.TMPDIR ?? '/tmp/'}spend-roth-${process.pid}.sqlite`
  const db = openDb(file)
  db.exec(`INSERT INTO accounts (name, type, in_net_worth) VALUES ('Roth 401k', 'retirement', 1)`)
  const id = (name: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(name) as { id: number }).id
  db.prepare(`INSERT INTO transactions (date, month, account_id, amount_cents, kind, transfer_id) VALUES ('2026-01-15', '2026-01', ?, 30000, 'transfer', 'a')`).run(id('Roth 401k'))
  db.prepare(`INSERT INTO snapshots (account_id, date, balance_cents) VALUES (?, '2026-01-31', 100000), (?, '2026-01-31', 40000), (?, '2026-02-28', 45000)`).run(id('401k'), id('Roth 401k'), id('Roth 401k'))
  db.close()
  const reopened = openDb(file)
  assert.equal((reopened.prepare(`SELECT COUNT(*) n FROM accounts WHERE name = 'Roth 401k'`).get() as { n: number }).n, 0)
  const k = (reopened.prepare(`SELECT id FROM accounts WHERE name = '401k'`).get() as { id: number }).id
  assert.deepEqual(reopened.prepare('SELECT account_id, amount_cents FROM transactions').all(), [{ account_id: k, amount_cents: 30000 }])
  assert.deepEqual(reopened.prepare('SELECT date, balance_cents FROM snapshots WHERE account_id = ? ORDER BY date').all(k), [
    { date: '2026-01-31', balance_cents: 140000 }, { date: '2026-02-28', balance_cents: 45000 },
  ])
  reopened.close()
  for (const suffix of ['', '-wal', '-shm']) (await import('node:fs')).rmSync(file + suffix, { force: true })
})
