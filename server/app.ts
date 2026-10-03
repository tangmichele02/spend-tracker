import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { Backups } from './backup.ts'
import { BadRequest, check } from './errors.ts'
import { registerReconcile } from './reconcile.ts'
import { mergeAccounts, NO_CATEGORY_COLOR, TAG_COLORS, type DB } from './db.ts'
import type {
  Account, Bootstrap, Category, Goal, MerchantGroup, MerchantRule, MonthSummary, NetWorth,
  Snapshot, TransferInput, Tx, TxInput, YearSummary,
} from '../shared/types.ts'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/


const TX_SELECT = `
SELECT t.id, t.date, t.month, t.account_id, a.name AS account_name, t.amount_cents, t.kind, t.description,
  t.category_id, c.name AS category_name, c.color AS category_color, t.one_off, t.cleared, t.transfer_id,
  oa.name AS other_account_name,
  t.reimburses_id, p.description AS reimburses_description, p.date AS reimburses_date,
  COALESCE((SELECT SUM(r.amount_cents) FROM transactions r WHERE r.reimburses_id = t.id), 0) AS reimbursed_cents
FROM transactions t
JOIN accounts a ON a.id = t.account_id
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN transactions p ON p.id = t.reimburses_id
LEFT JOIN transactions o ON o.transfer_id = t.transfer_id AND o.id <> t.id
LEFT JOIN accounts oa ON oa.id = o.account_id`

// Purchases and reimbursements, with a linked reimbursement taking on the month, category and
// one-off flag of the purchase it pays back. A September refund for an August shirt lowers August.
// eff_month is the month the entry counts in; eff_date is when it actually happened.
const SPENDING = `
SELECT t.id, t.kind, t.date, -t.amount_cents AS cents, t.reimburses_id,
  COALESCE(p.date, t.date) AS eff_date,
  COALESCE(p.month, t.month) AS eff_month,
  COALESCE(p.category_id, t.category_id) AS eff_category,
  COALESCE(p.one_off, t.one_off) AS eff_one_off,
  COALESCE(p.description, t.description) AS eff_description
FROM transactions t
LEFT JOIN transactions p ON p.id = t.reimburses_id
WHERE t.kind IN ('purchase', 'reimbursement')`

export function merchantFor(description: string, rules: MerchantRule[]): { merchant: string; matched: boolean } {
  for (const rule of rules) {
    if (rule.is_regex) {
      try {
        if (new RegExp(rule.pattern, 'i').test(description)) return { merchant: rule.merchant, matched: true }
      } catch {
        // An invalid pattern matches nothing.
      }
    } else if (description.toLowerCase().includes(rule.pattern.toLowerCase())) {
      return { merchant: rule.merchant, matched: true }
    }
  }
  // No rule: group on the typed text, minus a trailing store number.
  const cleaned = description.replace(/\s+/g, ' ').replace(/\s*#?\d{3,}$/, '').trim()
  return { merchant: cleaned || '(no description)', matched: false }
}

export function createApp(db: DB, backups?: Backups) {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400)
    if (err instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400)
    if ((err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
      return c.json({ error: 'That conflicts with existing data (duplicate name, or still in use).' }, 409)
    }
    console.error(err)
    return c.json({ error: 'Server error' }, 500)
  })

  const accountById = (id: unknown) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account | undefined
  const txById = (id: unknown) => db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(id) as Tx | undefined
  const rules = () => db.prepare('SELECT * FROM merchant_rules ORDER BY id').all() as MerchantRule[]

  function validateTx(body: TxInput) {
    check(['purchase', 'income', 'reimbursement'].includes(body.kind), 'Unknown kind')
    check(ISO_DATE.test(body.date ?? ''), 'Date must be YYYY-MM-DD')
    check(body.month == null || ISO_MONTH.test(body.month), 'Month must be YYYY-MM')
    check(Number.isInteger(body.amount_cents) && body.amount_cents !== 0, 'Amount is required')
    check(accountById(body.account_id), 'Unknown account')
    if (body.reimburses_id != null) {
      check(body.kind === 'reimbursement', 'Only a reimbursement can link to a purchase')
      const target = db.prepare('SELECT kind FROM transactions WHERE id = ?').get(body.reimburses_id) as { kind: string } | undefined
      check(target?.kind === 'purchase', 'A reimbursement must link to a purchase')
    }
  }
  // Amounts arrive positive as typed; a purchase takes money out of the account.
  const signed = (kind: string, cents: number) => (kind === 'purchase' ? -cents : cents)

  const insertTx = db.prepare(`
    INSERT INTO transactions (date, month, account_id, amount_cents, kind, description, category_id, one_off, reimburses_id)
    VALUES (@date, @month, @account_id, @amount_cents, @kind, @description, @category_id, @one_off, @reimburses_id)`)
  function addTx(body: TxInput): number {
    validateTx(body)
    const hasCategory = body.kind !== 'income'
    return Number(insertTx.run({
      date: body.date,
      month: body.month ?? body.date.slice(0, 7),
      account_id: body.account_id,
      amount_cents: signed(body.kind, body.amount_cents),
      kind: body.kind,
      description: (body.description ?? '').trim(),
      category_id: hasCategory ? body.category_id ?? null : null,
      one_off: body.one_off ? 1 : 0,
      reimburses_id: body.reimburses_id ?? null,
    }).lastInsertRowid)
  }

  app.get('/api/bootstrap', (c) => {
    const result: Bootstrap = {
      accounts: db.prepare('SELECT * FROM accounts ORDER BY sort, id').all() as Account[],
      categories: db.prepare('SELECT id, name, color, archived FROM categories ORDER BY sort, id').all() as Category[],
      // Most recent use of each description, for autocomplete and category defaults.
      descriptions: db.prepare(`
        SELECT description, category_id, account_id FROM transactions
        WHERE kind = 'purchase' AND description <> ''
        GROUP BY description COLLATE NOCASE HAVING id = MAX(id)
        ORDER BY id DESC LIMIT 2000`).all() as Bootstrap['descriptions'],
    }
    return c.json(result)
  })

  // ---- Transactions ----

  app.get('/api/transactions', (c) => {
    const q = c.req.query()
    const where: string[] = []
    const params: Record<string, unknown> = {}
    if (q.from) { where.push('t.date >= @from'); params.from = q.from }
    if (q.to) { where.push('t.date <= @to'); params.to = q.to }
    if (q.month) { where.push('t.month = @month'); params.month = q.month }
    if (q.account) { where.push('t.account_id = @account'); params.account = +q.account }
    // Without an account filter a transfer would list twice, so show only the sending side.
    else where.push("NOT (t.kind = 'transfer' AND t.amount_cents > 0 AND o.id IS NOT NULL)")
    if (q.category === 'none') where.push("t.category_id IS NULL AND t.kind IN ('purchase','reimbursement')")
    else if (q.category) { where.push('t.category_id = @category'); params.category = +q.category }
    if (q.kind) { where.push('t.kind = @kind'); params.kind = q.kind }
    if (q.one_off === '1') where.push('t.one_off = 1')
    if (q.q) { where.push("t.description LIKE @q ESCAPE '\\'"); params.q = `%${q.q.replace(/[\\%_]/g, '\\$&')}%` }
    const limit = Math.min(+(q.limit ?? 500) || 500, 5000)
    const offset = +(q.offset ?? 0) || 0
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = db.prepare(`${TX_SELECT} ${clause} ORDER BY t.date DESC, t.id DESC LIMIT ${limit + 1} OFFSET ${offset}`).all(params) as Tx[]
    return c.json({ rows: rows.slice(0, limit), more: rows.length > limit })
  })

  app.post('/api/transactions', async (c) => c.json(txById(addTx(await c.req.json()))))

  function addTransfer(body: TransferInput): number | bigint {
    check(ISO_DATE.test(body.date ?? ''), 'Date must be YYYY-MM-DD')
    check(body.month == null || ISO_MONTH.test(body.month), 'Month must be YYYY-MM')
    check(Number.isInteger(body.amount_cents) && body.amount_cents > 0, 'Amount must be positive')
    check(accountById(body.to_account_id), 'Unknown destination account')
    check(body.from_account_id == null || accountById(body.from_account_id), 'Unknown source account')
    check(body.from_account_id !== body.to_account_id, 'Source and destination must differ')
    const transferId = randomUUID()
    const leg = db.prepare(`INSERT INTO transactions (date, month, account_id, amount_cents, kind, description, transfer_id)
      VALUES (?, ?, ?, ?, 'transfer', ?, ?)`)
    const description = (body.description ?? '').trim()
    const month = body.month ?? body.date.slice(0, 7)
    return db.transaction(() => {
      const to = leg.run(body.date, month, body.to_account_id, body.amount_cents, description, transferId).lastInsertRowid
      if (body.from_account_id == null) return to
      return leg.run(body.date, month, body.from_account_id, -body.amount_cents, description, transferId).lastInsertRowid
    })()
  }
  app.post('/api/transfers', async (c) => c.json(txById(addTransfer(await c.req.json()))))

  // Bulk transfers from the paste screen (savings, investment and 401k contributions). As with
  // /api/import, a row is skipped when the same move on the same date is already recorded.
  app.post('/api/import-transfers', async (c) => {
    const { rows } = (await c.req.json()) as { rows: TransferInput[] }
    check(Array.isArray(rows), 'rows is required')
    const existing = db.prepare(`
      SELECT t.transfer_id, t.month FROM transactions t
      LEFT JOIN transactions o ON o.transfer_id = t.transfer_id AND o.id <> t.id
      WHERE t.kind = 'transfer' AND t.amount_cents > 0 AND t.date = ? AND t.account_id = ? AND t.amount_cents = ?
        AND o.account_id IS ? ORDER BY t.id`)
    const move = db.prepare('UPDATE transactions SET month = ? WHERE transfer_id = ?')
    const result = db.transaction(() => {
      const matches = new Map<string, { transfer_id: string; month: string }[]>()
      let inserted = 0
      let skipped = 0
      let moved = 0
      for (const row of rows) {
        const from = row.from_account_id ?? null
        const key = [row.date, from, row.to_account_id, row.amount_cents].join('|')
        if (!matches.has(key)) {
          matches.set(key, existing.all(row.date, row.to_account_id, row.amount_cents, from) as { transfer_id: string; month: string }[])
        }
        const match = matches.get(key)!.shift()
        if (match) {
          if (row.month && row.month !== match.month) { move.run(row.month, match.transfer_id); moved++ } else skipped++
          continue
        }
        addTransfer(row)
        inserted++
      }
      return { inserted, skipped, moved }
    })()
    return c.json(result)
  })

  app.patch('/api/transactions/:id', async (c) => {
    const id = +c.req.param('id')
    const existing = txById(id)
    check(existing, 'Transaction not found')
    const body = (await c.req.json()) as Partial<TxInput> & { cleared?: boolean }
    if (body.cleared !== undefined) db.prepare('UPDATE transactions SET cleared = ? WHERE id = ?').run(body.cleared ? 1 : 0, id)

    if (body.month !== undefined) {
      check(ISO_MONTH.test(body.month), 'Month must be YYYY-MM')
      if (existing.transfer_id) db.prepare('UPDATE transactions SET month = ? WHERE transfer_id = ?').run(body.month, existing.transfer_id)
      else db.prepare('UPDATE transactions SET month = ? WHERE id = ?').run(body.month, id)
    }

    if (existing.kind === 'transfer') {
      // Both sides of a transfer share date, description and amount.
      if (body.date !== undefined) {
        check(ISO_DATE.test(body.date), 'Date must be YYYY-MM-DD')
        db.prepare('UPDATE transactions SET date = ? WHERE transfer_id = ?').run(body.date, existing.transfer_id)
      }
      if (body.description !== undefined) {
        db.prepare('UPDATE transactions SET description = ? WHERE transfer_id = ?').run(body.description.trim(), existing.transfer_id)
      }
      if (body.amount_cents !== undefined) {
        check(Number.isInteger(body.amount_cents) && body.amount_cents > 0, 'Amount must be positive')
        db.prepare(`UPDATE transactions SET amount_cents = CASE WHEN amount_cents < 0 THEN -@v ELSE @v END
          WHERE transfer_id = @t`).run({ v: body.amount_cents, t: existing.transfer_id })
      }
    } else if (['date', 'account_id', 'amount_cents', 'description', 'category_id', 'one_off', 'reimburses_id', 'kind'].some((k) => k in body)) {
      const merged: TxInput = {
        kind: (body.kind ?? existing.kind) as TxInput['kind'],
        date: body.date ?? existing.date,
        account_id: body.account_id ?? existing.account_id,
        amount_cents: body.amount_cents ?? signed(existing.kind, existing.amount_cents),
        description: body.description ?? existing.description,
        category_id: body.category_id !== undefined ? body.category_id : existing.category_id,
        one_off: body.one_off ?? !!existing.one_off,
        reimburses_id: body.reimburses_id !== undefined ? body.reimburses_id : existing.reimburses_id,
      }
      if (merged.kind !== 'reimbursement') merged.reimburses_id = null
      check(merged.reimburses_id !== id, 'A transaction cannot reimburse itself')
      validateTx(merged)
      const hasCategory = merged.kind !== 'income'
      db.prepare(`UPDATE transactions SET kind = ?, date = ?, account_id = ?, amount_cents = ?, description = ?,
        category_id = ?, one_off = ?, reimburses_id = ? WHERE id = ?`).run(
        merged.kind, merged.date, merged.account_id, signed(merged.kind, merged.amount_cents), merged.description.trim(),
        hasCategory ? merged.category_id : null, merged.one_off ? 1 : 0, merged.reimburses_id ?? null, id)
    }
    return c.json(txById(id))
  })

  app.delete('/api/transactions/:id', (c) => {
    const existing = txById(+c.req.param('id'))
    check(existing, 'Transaction not found')
    if (existing.transfer_id) db.prepare('DELETE FROM transactions WHERE transfer_id = ?').run(existing.transfer_id)
    else db.prepare('DELETE FROM transactions WHERE id = ?').run(existing.id)
    return c.json({ ok: true })
  })

  // Bulk insert from the paste screen. Pasting the same block twice adds nothing: a row is
  // skipped when an identical one already exists, counting repeats (two equal coffees on one
  // day are both kept the first time). If the paste names a month and the existing row is filed
  // under another, the existing row is moved rather than duplicated.
  app.post('/api/import', async (c) => {
    const { rows } = (await c.req.json()) as { rows: TxInput[] }
    check(Array.isArray(rows), 'rows is required')
    const existing = db.prepare(`SELECT id, month FROM transactions
      WHERE date = ? AND account_id = ? AND amount_cents = ? AND kind = ? AND description = ? COLLATE NOCASE ORDER BY id`)
    const move = db.prepare('UPDATE transactions SET month = ? WHERE id = ?')
    const result = db.transaction(() => {
      const matches = new Map<string, { id: number; month: string }[]>()
      let inserted = 0
      let skipped = 0
      let moved = 0
      for (const row of rows) {
        validateTx(row)
        const description = (row.description ?? '').trim()
        const amount = signed(row.kind, row.amount_cents)
        const key = [row.date, row.account_id, amount, row.kind, description.toLowerCase()].join('|')
        if (!matches.has(key)) {
          matches.set(key, existing.all(row.date, row.account_id, amount, row.kind, description) as { id: number; month: string }[])
        }
        const match = matches.get(key)!.shift()
        if (match) {
          if (row.month && row.month !== match.month) { move.run(row.month, match.id); moved++ } else skipped++
          continue
        }
        addTx(row)
        inserted++
      }
      return { inserted, skipped, moved }
    })()
    return c.json(result)
  })

  app.get('/api/export.csv', (c) => {
    const rows = db.prepare(`${TX_SELECT} ORDER BY t.date, t.id`).all() as Tx[]
    const cell = (v: unknown) => {
      let s = String(v ?? '')
      // Keep a description starting with = + - @ from running as a formula when opened in a spreadsheet.
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [['date', 'month', 'account', 'kind', 'amount', 'description', 'category', 'one_off', 'other_account', 'reimburses'].join(',')]
    for (const r of rows) {
      lines.push([r.date, r.month, r.account_name, r.kind, (r.amount_cents / 100).toFixed(2), r.description, r.category_name,
        r.one_off ? 'yes' : '', r.other_account_name, r.reimburses_description].map(cell).join(','))
    }
    c.header('Content-Type', 'text/csv; charset=utf-8')
    c.header('Content-Disposition', `attachment; filename="spend-tracker-${new Date().toLocaleDateString('en-CA')}.csv"`)
    return c.body(lines.join('\n') + '\n')
  })

  // ---- Summaries ----

  // Balance once every entry filed under this month or earlier has gone through.
  const balanceAt = db.prepare(`SELECT a.opening_cents + COALESCE(SUM(t.amount_cents), 0) AS cents
    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id AND t.month <= @month WHERE a.id = @id`)

  app.get('/api/month/:month', (c) => {
    const month = c.req.param('month')
    check(ISO_MONTH.test(month), 'Month must be YYYY-MM')
    const from = `${month}-01`
    const to = `${month}-31`
    const income = db.prepare(`SELECT COALESCE(SUM(CASE WHEN one_off = 0 THEN amount_cents END), 0) AS regular,
      COALESCE(SUM(CASE WHEN one_off = 1 THEN amount_cents END), 0) AS one_off FROM transactions
      WHERE kind = 'income' AND month = ?`).get(month) as { regular: number; one_off: number }
    const spend = db.prepare(`
      SELECT s.eff_category AS category_id, COALESCE(c.name, 'Uncategorized') AS name, COALESCE(c.color, '${NO_CATEGORY_COLOR}') AS color, s.eff_one_off AS one_off, SUM(s.cents) AS cents
      FROM (${SPENDING}) s LEFT JOIN categories c ON c.id = s.eff_category
      WHERE s.eff_month = ?
      GROUP BY s.eff_category, s.eff_one_off`).all(month) as { category_id: number | null; name: string; color: string; one_off: number; cents: number }[]
    const moved = db.prepare(`
      SELECT a.type, SUM(t.amount_cents) AS cents FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.kind = 'transfer' AND t.month = ? AND a.type IN ('savings','investment','retirement')
      GROUP BY a.type`).all(month) as { type: 'savings' | 'investment' | 'retirement'; cents: number }[]
    const accounts = (db.prepare(`SELECT * FROM accounts WHERE type = 'checking' AND archived = 0 ORDER BY sort, id`).all() as Account[]).map((a) => {
      const snap = db.prepare(`SELECT date, balance_cents FROM snapshots WHERE account_id = ? AND date BETWEEN ? AND ?
        ORDER BY date DESC LIMIT 1`).get(a.id, from, to) as { date: string; balance_cents: number } | undefined
      const balance = (balanceAt.get({ id: a.id, month }) as { cents: number }).cents
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        balance_cents: balance,
        uncleared: (db.prepare(`SELECT COUNT(*) n FROM transactions WHERE account_id = ? AND cleared = 0 AND month = ?`).get(a.id, month) as { n: number }).n,
        // The bank figure typed for this month is checked against the month's closing balance.
        snapshot: snap ? { ...snap, computed_cents: balance } : null,
      }
    })
    const regular = spend.filter((s) => !s.one_off)
    const result: MonthSummary = {
      month,
      income_cents: income.regular,
      one_off_income_cents: income.one_off,
      spending_cents: regular.reduce((n, s) => n + s.cents, 0),
      one_off_cents: spend.filter((s) => s.one_off).reduce((n, s) => n + s.cents, 0),
      categories: regular.map(({ category_id, name, color, cents }) => ({ category_id, name, color, cents })).sort((a, b) => b.cents - a.cents),
      moved: { savings: 0, investment: 0, retirement: 0, ...Object.fromEntries(moved.map((m) => [m.type, m.cents])) },
      accounts,
    }
    return c.json(result)
  })

  app.get('/api/year/:year', (c) => {
    const year = +c.req.param('year')
    check(Number.isInteger(year), 'Year must be a number')
    const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
    const idx = (m: string) => months.indexOf(m)
    const zeros = () => Array(12).fill(0) as number[]
    const range = [`${year}-01`, `${year}-12`]

    const spend = db.prepare(`
      SELECT s.eff_month AS month, s.eff_category AS category_id, s.eff_one_off AS one_off, SUM(s.cents) AS cents
      FROM (${SPENDING}) s WHERE s.eff_month BETWEEN ? AND ? GROUP BY 1, 2, 3`).all(...range) as { month: string; category_id: number | null; one_off: number; cents: number }[]
    const categories = (db.prepare('SELECT id, name, color FROM categories ORDER BY sort, id').all() as { id: number | null; name: string; color: string }[])
      .map((cat) => ({ category_id: cat.id, name: cat.name, color: cat.color, cents: zeros() }))
    const uncategorized = { category_id: null as number | null, name: 'Uncategorized', color: NO_CATEGORY_COLOR, cents: zeros() }
    const oneOff = zeros()
    for (const row of spend) {
      if (row.one_off) oneOff[idx(row.month)] += row.cents
      else (categories.find((cat) => cat.category_id === row.category_id) ?? uncategorized).cents[idx(row.month)] += row.cents
    }
    if (uncategorized.cents.some(Boolean)) categories.push(uncategorized)

    const income = zeros()
    const oneOffIncome = zeros()
    for (const row of db.prepare(`SELECT month, one_off, SUM(amount_cents) AS cents FROM transactions
      WHERE kind = 'income' AND month BETWEEN ? AND ? GROUP BY 1, 2`).all(...range) as { month: string; one_off: number; cents: number }[]) {
      ;(row.one_off ? oneOffIncome : income)[idx(row.month)] = row.cents
    }

    const contributions: YearSummary['contributions'] = (db.prepare(`SELECT id, name, type FROM accounts
      WHERE type IN ('savings','investment','retirement') ORDER BY sort, id`).all() as Account[])
      .map((a) => ({ account_id: a.id, name: a.name, type: a.type, cents: zeros(), paycheck: zeros() }))
    // A transfer with no other side came straight out of a paycheck.
    for (const row of db.prepare(`SELECT t.account_id, t.month, SUM(t.amount_cents) AS cents,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM transactions o WHERE o.transfer_id = t.transfer_id AND o.id <> t.id) THEN t.amount_cents ELSE 0 END) AS paycheck
      FROM transactions t WHERE t.kind = 'transfer' AND t.month BETWEEN ? AND ? GROUP BY 1, 2`).all(...range) as { account_id: number; month: string; cents: number; paycheck: number }[]) {
      const target = contributions.find((a) => a.account_id === row.account_id)
      if (target) {
        target.cents[idx(row.month)] = row.cents
        target.paycheck[idx(row.month)] = row.paycheck
      }
    }

    const result: YearSummary = {
      year, months,
      categories: categories.filter((cat) => cat.cents.some(Boolean) || cat.category_id !== null),
      one_off: oneOff, income, one_off_income: oneOffIncome, contributions,
    }
    return c.json(result)
  })

  app.get('/api/merchants', (c) => {
    const { from = '0000-01-01', to = '9999-12-31' } = c.req.query()
    const ruleList = rules()
    // Unlinked reimbursements (a friend paying you back) are not purchases from a company.
    const rows = db.prepare(`
      SELECT s.id, s.date, s.cents, s.eff_description AS description, c.name AS category_name
      FROM (${SPENDING}) s LEFT JOIN categories c ON c.id = s.eff_category
      WHERE s.eff_date BETWEEN ? AND ? AND (s.kind = 'purchase' OR s.reimburses_id IS NOT NULL)
      ORDER BY s.date DESC, s.id DESC`).all(from, to) as { id: number; date: string; cents: number; description: string; category_name: string | null }[]
    const groups = new Map<string, MerchantGroup>()
    for (const row of rows) {
      const { merchant, matched } = merchantFor(row.description, ruleList)
      const key = merchant.toLowerCase()
      let group = groups.get(key)
      if (!group) groups.set(key, (group = { merchant, matched_rule: matched, cents: 0, count: 0, first: row.date, last: row.date, items: [] }))
      group.cents += row.cents
      if (row.cents > 0) group.count++
      if (row.date < group.first) group.first = row.date
      if (row.date > group.last) group.last = row.date
      group.items.push(row)
    }
    return c.json([...groups.values()].sort((a, b) => b.cents - a.cents))
  })

  app.get('/api/networth', (c) => {
    const accounts = db.prepare('SELECT * FROM accounts WHERE in_net_worth = 1 ORDER BY sort, id').all() as Account[]
    const ids = new Set(accounts.map((a) => a.id))
    const snapshots = (db.prepare('SELECT * FROM snapshots ORDER BY date, id').all() as Snapshot[]).filter((s) => ids.has(s.account_id))
    // At each date any balance was recorded, every account counts at its most recent balance.
    const latest = new Map<number, number>()
    const series: NetWorth['series'] = []
    const retirement = new Set(accounts.filter((a) => a.type === 'retirement').map((a) => a.id))
    for (const snap of snapshots) {
      latest.set(snap.account_id, snap.balance_cents)
      let total = 0
      let nonRetirement = 0
      for (const [id, cents] of latest) {
        total += cents
        if (!retirement.has(id)) nonRetirement += cents
      }
      const point = { date: snap.date, total, non_retirement: nonRetirement }
      if (series.at(-1)?.date === snap.date) series[series.length - 1] = point
      else series.push(point)
    }
    const goals = (db.prepare('SELECT * FROM goals ORDER BY target_date, id').all() as (Omit<Goal, 'account_ids'> & { account_ids: string })[]).map((g) => {
      const accountIds = JSON.parse(g.account_ids) as number[]
      let current = 0
      for (const [id, cents] of latest) if (accountIds.length === 0 || accountIds.includes(id)) current += cents
      return { ...g, account_ids: accountIds, current_cents: current }
    })
    const result: NetWorth = { accounts, snapshots, series, goals }
    return c.json(result)
  })

  // ---- Snapshots, goals, rules, accounts, categories ----

  app.post('/api/snapshots', async (c) => {
    const body = (await c.req.json()) as { rows: Omit<Snapshot, 'id'>[] }
    check(Array.isArray(body.rows), 'rows is required')
    const upsert = db.prepare(`INSERT INTO snapshots (account_id, date, balance_cents) VALUES (?, ?, ?)
      ON CONFLICT (account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents`)
    db.transaction(() => {
      for (const row of body.rows) {
        check(ISO_DATE.test(row.date ?? '') && Number.isInteger(row.balance_cents) && accountById(row.account_id), 'Invalid balance row')
        upsert.run(row.account_id, row.date, row.balance_cents)
      }
    })()
    return c.json({ saved: body.rows.length })
  })
  app.delete('/api/snapshots', (c) => {
    const { account_id, date } = c.req.query()
    if (account_id) db.prepare('DELETE FROM snapshots WHERE account_id = ? AND date = ?').run(+account_id, date)
    else db.prepare('DELETE FROM snapshots WHERE date = ? AND account_id IN (SELECT id FROM accounts WHERE in_net_worth = 1)').run(date)
    return c.json({ ok: true })
  })

  app.post('/api/goals', async (c) => {
    const g = (await c.req.json()) as Omit<Goal, 'id'>
    check(g.name?.trim() && Number.isInteger(g.target_cents) && g.target_cents > 0 && ISO_DATE.test(g.target_date ?? ''), 'A goal needs a name, a target amount and a date')
    db.prepare('INSERT INTO goals (name, target_cents, target_date, account_ids) VALUES (?, ?, ?, ?)')
      .run(g.name.trim(), g.target_cents, g.target_date, JSON.stringify(g.account_ids ?? []))
    return c.json({ ok: true })
  })
  app.delete('/api/goals/:id', (c) => {
    db.prepare('DELETE FROM goals WHERE id = ?').run(+c.req.param('id'))
    return c.json({ ok: true })
  })

  app.get('/api/rules', (c) => c.json(rules()))
  app.post('/api/rules', async (c) => {
    const r = (await c.req.json()) as Omit<MerchantRule, 'id'>
    check(r.pattern?.trim() && r.merchant?.trim(), 'A rule needs a pattern and a company name')
    if (r.is_regex) {
      try { new RegExp(r.pattern) } catch { throw new BadRequest('That regular expression is not valid') }
    }
    db.prepare('INSERT INTO merchant_rules (pattern, is_regex, merchant) VALUES (?, ?, ?)').run(r.pattern.trim(), r.is_regex ? 1 : 0, r.merchant.trim())
    return c.json({ ok: true })
  })
  app.delete('/api/rules/:id', (c) => {
    db.prepare('DELETE FROM merchant_rules WHERE id = ?').run(+c.req.param('id'))
    return c.json({ ok: true })
  })

  const TYPES = ['checking', 'savings', 'investment', 'retirement']
  app.post('/api/accounts', async (c) => {
    const a = (await c.req.json()) as Partial<Account>
    const name = a.name?.trim()
    check(name && TYPES.includes(a.type ?? ''), 'An account needs a name and a type')
    const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 n FROM accounts').get() as { n: number }).n
    db.prepare('INSERT INTO accounts (name, type, opening_cents, in_net_worth, sort) VALUES (?, ?, ?, ?, ?)')
      .run(name, a.type, a.opening_cents ?? 0, a.in_net_worth ?? (a.type === 'checking' ? 0 : 1), sort)
    return c.json({ ok: true })
  })
  app.patch('/api/accounts/:id', async (c) => {
    const existing = accountById(+c.req.param('id'))
    check(existing, 'Account not found')
    const a = { ...existing, ...((await c.req.json()) as Partial<Account>) }
    check(a.name?.trim() && TYPES.includes(a.type) && Number.isInteger(a.opening_cents), 'Invalid account')
    db.prepare('UPDATE accounts SET name = ?, type = ?, opening_cents = ?, in_net_worth = ?, archived = ? WHERE id = ?')
      .run(a.name.trim(), a.type, a.opening_cents, a.in_net_worth ? 1 : 0, a.archived ? 1 : 0, existing.id)
    return c.json({ ok: true })
  })
  app.post('/api/accounts/:id/merge', async (c) => {
    const from = accountById(+c.req.param('id'))
    const into = accountById(((await c.req.json()) as { into?: number }).into)
    check(from && into && from.id !== into.id, 'Choose a different account to merge into')
    check(from.type === into.type, 'Only accounts of the same type can be merged')
    mergeAccounts(db, from.id, into.id, 'keep')
    return c.json({ ok: true })
  })
  app.delete('/api/accounts/:id', (c) => {
    // Fails with a conflict if anything still refers to the account; archive it instead.
    db.prepare('DELETE FROM accounts WHERE id = ?').run(+c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/categories', async (c) => {
    const name = ((await c.req.json()) as { name?: string }).name?.trim()
    check(name, 'A category needs a name')
    const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 n FROM categories').get() as { n: number }).n
    const count = (db.prepare('SELECT COUNT(*) n FROM categories').get() as { n: number }).n
    db.prepare('INSERT INTO categories (name, sort, color) VALUES (?, ?, ?)').run(name, sort, TAG_COLORS[count % TAG_COLORS.length])
    return c.json({ ok: true })
  })
  app.patch('/api/categories/:id', async (c) => {
    const id = +c.req.param('id')
    const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Category | undefined
    check(existing, 'Category not found')
    const cat = { ...existing, ...((await c.req.json()) as Partial<Category>) }
    check(cat.name?.trim(), 'A category needs a name')
    check(/^#[0-9a-f]{6}$/i.test(cat.color), 'Colour must look like #ffcad4')
    db.prepare('UPDATE categories SET name = ?, archived = ?, color = ? WHERE id = ?').run(cat.name.trim(), cat.archived ? 1 : 0, cat.color, id)
    return c.json({ ok: true })
  })
  app.delete('/api/categories/:id', (c) => {
    db.prepare('DELETE FROM categories WHERE id = ?').run(+c.req.param('id'))
    return c.json({ ok: true })
  })

  registerReconcile(app, db, { addTx, addTransfer, txById })

  // ---- Backups ----

  app.get('/api/backup', (c) => c.json(backups?.status() ?? null))
  app.post('/api/backup', async (c) => {
    check(backups, 'Backups are not available')
    const body = (await c.req.json()) as { extraDir?: string }
    if (body.extraDir !== undefined) backups.setExtraDir(body.extraDir)
    await backups.run()
    return c.json(backups.status())
  })

  return app
}
