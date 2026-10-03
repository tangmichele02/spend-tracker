// Reconciling a month against bank and card exports: every checking line is accounted for by
// entries in the app, and each card payment is broken back into the card lines it paid.
import type { Hono } from 'hono'
import type { StatementBankLine, StatementCardLine } from '../shared/statements.ts'
import type {
  Account, BankLineRow, Card, CardLineRow, Proposal, ReconcileLine, ReconcileView, ResolveInput, TransferInput, Tx, TxInput,
} from '../shared/types.ts'
import type { DB } from './db.ts'
import { check } from './errors.ts'

interface Helpers {
  addTx: (body: TxInput) => number
  addTransfer: (body: TransferInput) => number | bigint
  txById: (id: unknown) => Tx | undefined
}

const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
// How far apart a checking payment and the card's record of it can be dated.
const PAYMENT_WINDOW_DAYS = 7
// How far a typed entry's date can be from the bank's, and still be taken as the same thing.
const ENTRY_WINDOW_DAYS = 5

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Picks which unpaid card lines a payment covers. Card balances are paid oldest first, so try the
 * oldest lines in order; if no run of them adds up exactly, try leaving one out (a charge still
 * pending when the payment was set, say). Failing both, offer the closest run for the user to adjust.
 */
export function choosePaid(amounts: number[], payment: number): { picked: Set<number>; exact: boolean } {
  const prefix = [0]
  for (const a of amounts) prefix.push(prefix[prefix.length - 1] + a)
  for (let k = 1; k <= amounts.length; k++) {
    if (prefix[k] === payment) return { picked: new Set(Array.from({ length: k }, (_, i) => i)), exact: true }
  }
  for (let k = 2; k <= amounts.length; k++) {
    for (let skip = 0; skip < k; skip++) {
      if (prefix[k] - amounts[skip] === payment) {
        return { picked: new Set(Array.from({ length: k }, (_, i) => i).filter((i) => i !== skip)), exact: true }
      }
    }
  }
  let best = 0
  for (let k = 1; k <= amounts.length; k++) if (Math.abs(prefix[k] - payment) < Math.abs(prefix[best] - payment)) best = k
  return { picked: new Set(Array.from({ length: best }, (_, i) => i)), exact: false }
}

export function registerReconcile(app: Hono, db: DB, { addTx, addTransfer, txById }: Helpers) {
  const lineById = (id: unknown) => db.prepare('SELECT * FROM bank_lines WHERE id = ?').get(id) as BankLineRow | undefined
  const cardById = (id: unknown) => db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Card | undefined
  const linkedTxIds = (lineId: number) =>
    (db.prepare('SELECT id FROM transactions WHERE bank_line_id = ? ORDER BY date, id').all(lineId) as { id: number }[]).map((r) => r.id)
  const isOpen = (line: BankLineRow) => !line.ignored && line.card_payment_id === null && linkedTxIds(line.id).length === 0
  const balanceThrough = db.prepare(`SELECT a.opening_cents + COALESCE(SUM(t.amount_cents), 0) AS cents
    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id AND t.month <= @month WHERE a.id = @id`)

  // ---- Cards and statement files ----

  app.get('/api/cards', (c) => c.json(db.prepare('SELECT * FROM cards ORDER BY id').all()))
  app.post('/api/cards', async (c) => {
    const body = (await c.req.json()) as Partial<Card>
    const name = body.name?.trim()
    check(name && (body.issuer === 'chase' || body.issuer === 'capitalone'), 'A card needs a name and an issuer')
    const id = db.prepare('INSERT INTO cards (name, issuer, last4) VALUES (?, ?, ?)').run(name, body.issuer, (body.last4 ?? '').trim()).lastInsertRowid
    return c.json(cardById(id))
  })
  app.patch('/api/cards/:id', async (c) => {
    const card = cardById(+c.req.param('id'))
    check(card, 'Card not found')
    const body = { ...card, ...((await c.req.json()) as Partial<Card>) }
    check(body.name.trim(), 'A card needs a name')
    db.prepare('UPDATE cards SET name = ?, last4 = ? WHERE id = ?').run(body.name.trim(), body.last4.trim(), card.id)
    return c.json(cardById(card.id))
  })

  // Lines already loaded from an earlier, overlapping export are recognised and skipped.
  app.post('/api/statements', async (c) => {
    const body = (await c.req.json()) as
      | { kind: 'bank'; account_id: number; lines: StatementBankLine[] }
      | { kind: 'card'; card_id: number; lines: StatementCardLine[] }
    check(Array.isArray(body.lines), 'lines is required')
    let added = 0
    db.transaction(() => {
      if (body.kind === 'bank') {
        const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(body.account_id) as Account | undefined
        check(account?.type === 'checking', 'Choose a checking account for this file')
        const insert = db.prepare(`INSERT OR IGNORE INTO bank_lines (account_id, date, description, amount_cents, type, balance_cents, fingerprint)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
        for (const l of body.lines) added += insert.run(account.id, l.date, l.description, l.amount_cents, l.type ?? '', l.balance_cents, l.fingerprint).changes
      } else {
        check(cardById(body.card_id), 'Choose which card this file is for')
        const insert = db.prepare(`INSERT OR IGNORE INTO card_lines (card_id, date, description, amount_cents, kind, fingerprint)
          VALUES (?, ?, ?, ?, ?, ?)`)
        for (const l of body.lines) added += insert.run(body.card_id, l.date, l.description, l.amount_cents, l.kind, l.fingerprint).changes
      }
    })()
    return c.json({ added, already: body.lines.length - added })
  })

  // ---- Proposals ----

  function proposeCard(line: BankLineRow): Proposal | null {
    if (line.amount_cents >= 0) return null
    const payment = db.prepare(`
      SELECT * FROM card_lines WHERE kind = 'payment' AND amount_cents = ? AND date BETWEEN ? AND ?
        AND id NOT IN (SELECT card_payment_id FROM bank_lines WHERE card_payment_id IS NOT NULL)
      ORDER BY abs(julianday(date) - julianday(?)), id LIMIT 1`)
      .get(line.amount_cents, shiftDays(line.date, -PAYMENT_WINDOW_DAYS), shiftDays(line.date, PAYMENT_WINDOW_DAYS), line.date) as CardLineRow | undefined
    if (!payment) return null
    let queue = db.prepare(`
      SELECT id, card_id, date, description, amount_cents, kind FROM card_lines
      WHERE card_id = ? AND kind IN ('charge', 'refund') AND paid_by IS NULL AND date <= ?
      ORDER BY date, id LIMIT 400`).all(payment.card_id, shiftDays(payment.date, 2)) as CardLineRow[]
    // Earlier payments on the card that no checking line has claimed yet (an August payment, when
    // only September's checking is loaded) paid for the oldest lines first. Set those lines aside
    // so this payment is not matched to charges that were already paid.
    const earlier = db.prepare(`
      SELECT * FROM card_lines WHERE card_id = ? AND kind = 'payment' AND (date < ? OR (date = ? AND id < ?))
        AND id NOT IN (SELECT card_payment_id FROM bank_lines WHERE card_payment_id IS NOT NULL)
      ORDER BY date, id`).all(payment.card_id, payment.date, payment.date, payment.id) as CardLineRow[]
    for (const e of earlier) {
      const covered = queue.filter((q) => q.date <= shiftDays(e.date, 2))
      const result = choosePaid(covered.map((q) => q.amount_cents), -e.amount_cents)
      // Only set lines aside when the earlier payment adds up exactly; a guess could hide the wrong ones.
      if (!result.exact) continue
      const taken = new Set(covered.filter((_, i) => result.picked.has(i)).map((q) => q.id))
      queue = queue.filter((q) => !taken.has(q.id))
    }
    queue = queue.slice(0, 80)
    const { picked, exact } = choosePaid(queue.map((q) => q.amount_cents), -payment.amount_cents)

    // Card lines already typed in by hand: same account, amount and kind, dated within a few days.
    const used = new Set<number>()
    const findTyped = db.prepare(`
      SELECT id FROM transactions WHERE account_id = ? AND kind = ? AND amount_cents = ? AND bank_line_id IS NULL AND card_line_id IS NULL
        AND date BETWEEN ? AND ? ORDER BY abs(julianday(date) - julianday(?)), id`)
    const items = queue.map((q, i) => {
      const kind = q.amount_cents > 0 ? 'purchase' : 'reimbursement'
      const candidates = findTyped.all(line.account_id, kind, -q.amount_cents, shiftDays(q.date, -ENTRY_WINDOW_DAYS), shiftDays(q.date, ENTRY_WINDOW_DAYS), q.date) as { id: number }[]
      const hit = picked.has(i) ? candidates.find((cand) => !used.has(cand.id)) : undefined
      if (hit) used.add(hit.id)
      return { ...q, proposed: picked.has(i), existing: hit ? txById(hit.id) ?? null : null }
    })
    return { kind: 'card', card: cardById(payment.card_id)!, payment, items, exact }
  }

  function propose(line: BankLineRow, claimed: Set<number>): Proposal {
    const card = proposeCard(line)
    if (card) return card
    // Something typed by hand for this month with the same amount.
    const typed = (db.prepare(`
      SELECT id FROM transactions WHERE account_id = ? AND amount_cents = ? AND bank_line_id IS NULL AND card_line_id IS NULL
        AND (month = ? OR date BETWEEN ? AND ?) ORDER BY abs(julianday(date) - julianday(?)), id`)
      .all(line.account_id, line.amount_cents, line.date.slice(0, 7), shiftDays(line.date, -ENTRY_WINDOW_DAYS), shiftDays(line.date, ENTRY_WINDOW_DAYS), line.date) as { id: number }[])
      .find((r) => !claimed.has(r.id))
    if (typed) {
      claimed.add(typed.id)
      return { kind: 'existing', tx: txById(typed.id)! }
    }
    const text = `${line.description} ${line.type}`.toLowerCase()
    if (line.amount_cents > 0) {
      if (/payroll|direct dep|salary/.test(text)) return { kind: 'guess', type: 'income' }
      if (/zelle|partnerfi|transfer/.test(text)) return { kind: 'guess', type: 'transfer' }
      return { kind: 'guess', type: 'reimbursement' }
    }
    if (/misc_debit|to self|transfer|fidelity|savings|hysa/.test(text)) return { kind: 'guess', type: 'transfer' }
    return { kind: 'guess', type: 'purchase' }
  }

  app.get('/api/reconcile/:account/:month', (c) => {
    const accountId = +c.req.param('account')
    const month = c.req.param('month')
    check(ISO_MONTH.test(month), 'Month must be YYYY-MM')
    const rows = db.prepare(`SELECT * FROM bank_lines WHERE account_id = ? AND substr(date, 1, 7) = ? ORDER BY date, id`).all(accountId, month) as BankLineRow[]
    const claimed = new Set<number>()
    const lines: ReconcileLine[] = rows.map((row) => {
      const txs = linkedTxIds(row.id).map((id) => txById(id)!).filter(Boolean)
      const status = row.ignored ? 'ignored' : row.card_payment_id !== null || txs.length > 0 ? 'done' : 'open'
      const cardName = row.card_payment_id === null ? null
        : (db.prepare('SELECT c.name FROM card_lines l JOIN cards c ON c.id = l.card_id WHERE l.id = ?').get(row.card_payment_id) as { name: string } | undefined)?.name ?? null
      return { ...row, status, txs, card_name: cardName, proposal: status === 'open' ? propose(row, claimed) : null }
    })
    const withBalance = rows.filter((r) => r.balance_cents !== null)
    // Without balances in the export, use a closing balance typed from the statement.
    const typed = withBalance.length ? undefined : db.prepare(`SELECT balance_cents FROM snapshots WHERE account_id = ? AND substr(date, 1, 7) = ? ORDER BY date DESC LIMIT 1`)
      .get(accountId, month) as { balance_cents: number } | undefined
    const unmatched = (db.prepare(`SELECT id FROM transactions WHERE account_id = ? AND month = ? AND bank_line_id IS NULL ORDER BY date, id`).all(accountId, month) as { id: number }[])
      .map((r) => txById(r.id)!)
    const view: ReconcileView = {
      account_id: accountId,
      month,
      start: {
        app_cents: (balanceThrough.get({ id: accountId, month: shiftMonth(month, -1) }) as { cents: number }).cents,
        bank_cents: withBalance.length ? withBalance[0].balance_cents! - withBalance[0].amount_cents : null,
      },
      end: {
        app_cents: (balanceThrough.get({ id: accountId, month }) as { cents: number }).cents,
        bank_cents: withBalance.length ? withBalance[withBalance.length - 1].balance_cents : typed?.balance_cents ?? null,
        typed: !!typed,
      },
      lines,
      unmatched,
    }
    return c.json(view)
  })

  // ---- Resolving and undoing a line ----

  app.post('/api/reconcile/resolve', async (c) => {
    const body = (await c.req.json()) as ResolveInput
    const line = lineById(body.bank_line_id)
    check(line, 'Bank line not found')
    check(isOpen(line), 'This line is already accounted for. Undo it first to change it.')
    const month = line.date.slice(0, 7)
    const mark = db.prepare('UPDATE transactions SET bank_line_id = ?, from_bank = 1 WHERE id = ?')

    db.transaction(() => {
      if (body.action === 'card') {
        const payment = db.prepare(`SELECT * FROM card_lines WHERE id = ? AND kind = 'payment'`).get(body.card_payment_id) as CardLineRow | undefined
        check(payment && payment.amount_cents === line.amount_cents, 'That card payment does not match this line')
        check(!(db.prepare('SELECT 1 FROM bank_lines WHERE card_payment_id = ?').get(payment.id)), 'That card payment is already matched to another line')
        const items = body.items.map((i) => ({ ...i, row: db.prepare('SELECT * FROM card_lines WHERE id = ?').get(i.card_line_id) as (CardLineRow & { paid_by: number | null }) | undefined }))
        for (const i of items) {
          check(i.row && i.row.card_id === payment.card_id && i.row.kind !== 'payment' && i.row.paid_by === null, 'A chosen card line is not available')
        }
        const manual = body.manual ?? []
        for (const m of manual) {
          check(ISO_DATE.test(m.date ?? ''), 'Each added line needs a date')
          check(Number.isInteger(m.amount_cents) && m.amount_cents !== 0, 'Each added line needs an amount')
        }
        const total = items.reduce((n, i) => n + i.row!.amount_cents, 0) + manual.reduce((n, m) => n + m.amount_cents, 0)
        check(total === -payment.amount_cents, `The chosen lines add up to ${(total / 100).toFixed(2)}, not the payment of ${(-payment.amount_cents / 100).toFixed(2)}`)
        for (const i of items) {
          const row = i.row!
          if (i.existing_tx_id != null) {
            const tx = txById(i.existing_tx_id)
            check(tx && tx.account_id === line.account_id && tx.amount_cents === -row.amount_cents, 'A matched entry no longer fits its card line')
            db.prepare('UPDATE transactions SET bank_line_id = ?, card_line_id = ?, month = ?, category_id = COALESCE(?, category_id) WHERE id = ?')
              .run(line.id, row.id, month, i.category_id, tx.id)
          } else {
            const id = addTx({
              kind: row.amount_cents > 0 ? 'purchase' : 'reimbursement', date: row.date, month, account_id: line.account_id,
              amount_cents: Math.abs(row.amount_cents), description: row.description, category_id: i.category_id,
            })
            db.prepare('UPDATE transactions SET bank_line_id = ?, card_line_id = ?, from_bank = 1 WHERE id = ?').run(line.id, row.id, id)
          }
        }
        for (const m of manual) {
          const id = addTx({
            kind: m.amount_cents > 0 ? 'purchase' : 'reimbursement', date: m.date, month, account_id: line.account_id,
            amount_cents: Math.abs(m.amount_cents), description: m.description, category_id: m.category_id,
          })
          mark.run(line.id, id)
        }
        // A refund points back at the purchase it reverses when the card shows both: same merchant and amount.
        db.prepare(`
          UPDATE transactions SET reimburses_id = (
            SELECT p.id FROM transactions p JOIN card_lines pl ON pl.id = p.card_line_id JOIN card_lines rl ON rl.id = transactions.card_line_id
            WHERE p.kind = 'purchase' AND pl.card_id = rl.card_id AND pl.amount_cents = -rl.amount_cents AND lower(pl.description) = lower(rl.description)
            ORDER BY pl.date DESC LIMIT 1)
          WHERE bank_line_id = ? AND kind = 'reimbursement' AND reimburses_id IS NULL`).run(line.id)
        const paid = db.prepare('UPDATE card_lines SET paid_by = ? WHERE id = ?')
        for (const i of items) paid.run(line.id, i.card_line_id)
        db.prepare('UPDATE bank_lines SET card_payment_id = ? WHERE id = ?').run(payment.id, line.id)
      } else if (body.action === 'existing') {
        const tx = txById(body.tx_id)
        check(tx && tx.account_id === line.account_id && tx.amount_cents === line.amount_cents, 'That entry does not match this line')
        check(!(db.prepare('SELECT bank_line_id FROM transactions WHERE id = ?').get(tx.id) as { bank_line_id: number | null }).bank_line_id, 'That entry is already matched to another line')
        db.prepare('UPDATE transactions SET bank_line_id = ? WHERE id = ?').run(line.id, tx.id)
      } else if (body.action === 'entry') {
        check(Array.isArray(body.parts) && body.parts.length > 0, 'Add at least one entry')
        const signed = (p: (typeof body.parts)[number]) => (p.kind === 'purchase' ? -Math.abs(p.amount_cents) : Math.abs(p.amount_cents))
        for (const p of body.parts) {
          check(line.amount_cents < 0 ? p.kind === 'purchase' : p.kind !== 'purchase', line.amount_cents < 0 ? 'Money out can only be a purchase here' : 'Money in can be income or a reimbursement')
        }
        const total = body.parts.reduce((n, p) => n + signed(p), 0)
        check(total === line.amount_cents, `The parts add up to ${(Math.abs(total) / 100).toFixed(2)}, not ${(Math.abs(line.amount_cents) / 100).toFixed(2)}`)
        for (const p of body.parts) {
          const id = addTx({
            kind: p.kind, date: p.date || line.date, month, account_id: line.account_id, amount_cents: Math.abs(p.amount_cents),
            description: p.description || line.description, category_id: p.kind === 'income' ? null : p.category_id, one_off: p.one_off, reimburses_id: p.reimburses_id ?? null,
          })
          mark.run(line.id, id)
        }
      } else if (body.action === 'transfer') {
        check(body.other_account_id !== line.account_id, 'Choose the other account')
        const out = line.amount_cents < 0
        const id = addTransfer({
          date: line.date, month, amount_cents: Math.abs(line.amount_cents), description: body.description || line.description,
          from_account_id: out ? line.account_id : body.other_account_id, to_account_id: out ? body.other_account_id : line.account_id,
        })
        const transferId = (db.prepare('SELECT transfer_id FROM transactions WHERE id = ?').get(id) as { transfer_id: string }).transfer_id
        db.prepare('UPDATE transactions SET from_bank = 1 WHERE transfer_id = ?').run(transferId)
        db.prepare('UPDATE transactions SET bank_line_id = ? WHERE transfer_id = ? AND account_id = ?').run(line.id, transferId, line.account_id)
      } else if (body.action === 'ignore') {
        db.prepare('UPDATE bank_lines SET ignored = 1 WHERE id = ?').run(line.id)
      } else {
        check(false, 'Unknown action')
      }
    })()
    return c.json({ ok: true })
  })

  // Puts a line back to open: entries it created are deleted, entries typed by hand are only unlinked.
  app.post('/api/reconcile/undo', async (c) => {
    const { bank_line_id } = (await c.req.json()) as { bank_line_id: number }
    const line = lineById(bank_line_id)
    check(line, 'Bank line not found')
    db.transaction(() => {
      for (const t of db.prepare('SELECT id, transfer_id, from_bank FROM transactions WHERE bank_line_id = ?').all(line.id) as { id: number; transfer_id: string | null; from_bank: number }[]) {
        if (!t.from_bank) db.prepare('UPDATE transactions SET bank_line_id = NULL, card_line_id = NULL WHERE id = ?').run(t.id)
        else if (t.transfer_id) db.prepare('DELETE FROM transactions WHERE transfer_id = ?').run(t.transfer_id)
        else db.prepare('DELETE FROM transactions WHERE id = ?').run(t.id)
      }
      db.prepare('UPDATE card_lines SET paid_by = NULL WHERE paid_by = ?').run(line.id)
      db.prepare('UPDATE bank_lines SET card_payment_id = NULL, ignored = 0 WHERE id = ?').run(line.id)
    })()
    return c.json({ ok: true })
  })
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7)
}
