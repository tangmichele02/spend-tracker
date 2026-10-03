import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

export type DB = Database.Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  -- 'card' is no longer created; it stays in the check so older databases still open.
  type TEXT NOT NULL CHECK (type IN ('checking','card','savings','investment','retirement')),
  opening_cents INTEGER NOT NULL DEFAULT 0,
  in_net_worth INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
-- amount_cents is signed from the account's point of view: a purchase is negative,
-- income and reimbursements are positive, a transfer is one negative and one positive row
-- sharing a transfer_id.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('purchase','income','reimbursement','transfer')),
  description TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id),
  one_off INTEGER NOT NULL DEFAULT 0,
  cleared INTEGER NOT NULL DEFAULT 0,
  transfer_id TEXT,
  reimburses_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS tx_account ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS tx_transfer ON transactions(transfer_id);
CREATE INDEX IF NOT EXISTS tx_reimburses ON transactions(reimburses_id);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  UNIQUE (account_id, date)
);
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  target_cents INTEGER NOT NULL,
  target_date TEXT NOT NULL,
  account_ids TEXT NOT NULL DEFAULT '[]'
);
-- Bank and card exports, kept so a month can be reconciled line by line and resumed later.
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  issuer TEXT NOT NULL CHECK (issuer IN ('chase','capitalone')),
  last4 TEXT NOT NULL DEFAULT ''
);
-- amount_cents is signed as spending: a charge is positive, a refund or payment negative.
-- paid_by is the checking line whose card payment covered this charge or refund.
CREATE TABLE IF NOT EXISTS card_lines (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id),
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('charge','refund','payment')),
  fingerprint TEXT NOT NULL,
  paid_by INTEGER REFERENCES bank_lines(id) ON DELETE SET NULL,
  UNIQUE (card_id, fingerprint)
);
-- amount_cents is signed from the account: money in is positive. card_payment_id is the payment
-- row in a card export that this checking line was matched to.
CREATE TABLE IF NOT EXISTS bank_lines (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  balance_cents INTEGER,
  fingerprint TEXT NOT NULL,
  card_payment_id INTEGER REFERENCES card_lines(id) ON DELETE SET NULL,
  ignored INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS bank_lines_month ON bank_lines(account_id, date);
CREATE INDEX IF NOT EXISTS card_lines_queue ON card_lines(card_id, paid_by, date);
CREATE TABLE IF NOT EXISTS merchant_rules (
  id INTEGER PRIMARY KEY,
  pattern TEXT NOT NULL,
  is_regex INTEGER NOT NULL DEFAULT 0,
  merchant TEXT NOT NULL
);
`

const SEED_ACCOUNTS: [string, string, number][] = [
  ['Chase', 'checking', 0],
  ['US Bank', 'checking', 0],
  ['WAB HYSA', 'savings', 1],
  ['Marcus', 'savings', 1],
  ['Bread', 'savings', 1],
  ['Fidelity', 'investment', 1],
  ['Roth IRA', 'retirement', 1],
  ['401k', 'retirement', 1],
  ['HSA', 'retirement', 1],
]
// Pastel tag colours, handed out in order to categories that have none.
export const TAG_COLORS = ['#ffcad4', '#b2ec9d', '#c2aef0', '#8ec3f3', '#ffe9ab', '#a8e6dc', '#ffcb95', '#f4b6e6', '#d6dde3']
export const NO_CATEGORY_COLOR = '#e4e4e0'
const SEED_CATEGORIES = ['Food', 'Groceries', 'Shopping', 'Subscriptions', 'Transportation', 'Travel', 'Healthcare']

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  if ((db.prepare('SELECT COUNT(*) n FROM accounts').get() as { n: number }).n === 0) {
    const acc = db.prepare('INSERT INTO accounts (name, type, in_net_worth, sort) VALUES (?, ?, ?, ?)')
    SEED_ACCOUNTS.forEach(([name, type, nw], i) => acc.run(name, type, nw, i))
    const cat = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)')
    SEED_CATEGORIES.forEach((name, i) => cat.run(name, i))
  }
  const columns = (db.prepare(`PRAGMA table_info(categories)`).all() as { name: string }[]).map((c) => c.name)
  if (!columns.includes('color')) db.exec('ALTER TABLE categories ADD COLUMN color TEXT')
  const paint = db.prepare('UPDATE categories SET color = ? WHERE id = ?')
  for (const cat of db.prepare('SELECT id FROM categories WHERE color IS NULL ORDER BY sort, id').all() as { id: number }[]) {
    const used = (db.prepare('SELECT COUNT(*) n FROM categories WHERE color IS NOT NULL').get() as { n: number }).n
    paint.run(TAG_COLORS[used % TAG_COLORS.length], cat.id)
  }
  // Entries created from, or matched to, a bank line point back at it. from_bank marks the ones
  // reconciliation created, so undoing a line deletes those and only unlinks entries typed by hand.
  for (const [column, ddl] of [
    ['bank_line_id', 'INTEGER REFERENCES bank_lines(id) ON DELETE SET NULL'],
    ['card_line_id', 'INTEGER REFERENCES card_lines(id) ON DELETE SET NULL'],
    ['from_bank', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    const existing = (db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[]).map((c) => c.name)
    if (!existing.includes(column)) db.exec(`ALTER TABLE transactions ADD COLUMN ${column} ${ddl}`)
  }
  db.exec('CREATE INDEX IF NOT EXISTS tx_bank_line ON transactions(bank_line_id)')
  // Every entry counts in a month of its own, separate from its date: a card purchase dated in
  // December that was paid from checking in January belongs to January.
  const txColumns = (db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[]).map((c) => c.name)
  if (!txColumns.includes('month')) db.exec('ALTER TABLE transactions ADD COLUMN month TEXT')
  db.exec(`UPDATE transactions SET month = substr(date, 1, 7) WHERE month IS NULL;
    CREATE INDEX IF NOT EXISTS tx_month ON transactions(month);`)
  // Roth and regular 401k are no longer told apart: fold anything recorded under "Roth 401k" into "401k".
  const roth = db.prepare(`SELECT id FROM accounts WHERE name = 'Roth 401k'`).get() as { id: number } | undefined
  const plain = db.prepare(`SELECT id FROM accounts WHERE name = '401k'`).get() as { id: number } | undefined
  if (roth && plain) {
    db.transaction(() => {
      db.prepare('UPDATE transactions SET account_id = ? WHERE account_id = ?').run(plain.id, roth.id)
      // Balances recorded for both on one date add up.
      db.prepare(`INSERT INTO snapshots (account_id, date, balance_cents) SELECT ?, date, balance_cents FROM snapshots WHERE account_id = ?
        ON CONFLICT (account_id, date) DO UPDATE SET balance_cents = balance_cents + excluded.balance_cents`).run(plain.id, roth.id)
      db.prepare('DELETE FROM snapshots WHERE account_id = ?').run(roth.id)
      for (const goal of db.prepare('SELECT id, account_ids FROM goals').all() as { id: number; account_ids: string }[]) {
        const ids = JSON.parse(goal.account_ids) as number[]
        if (!ids.includes(roth.id)) continue
        const merged = [...new Set(ids.map((id) => (id === roth.id ? plain.id : id)))]
        db.prepare('UPDATE goals SET account_ids = ? WHERE id = ?').run(JSON.stringify(merged), goal.id)
      }
      db.prepare('DELETE FROM accounts WHERE id = ?').run(roth.id)
    })()
  }
  // Credit cards were once accounts of their own. Purchases are now recorded against the checking
  // account that paid, so drop card accounts nothing refers to and hide any that were used.
  db.exec(`
    DELETE FROM accounts WHERE type = 'card'
      AND id NOT IN (SELECT account_id FROM transactions) AND id NOT IN (SELECT account_id FROM snapshots);
    UPDATE accounts SET archived = 1 WHERE type = 'card';
  `)
  return db
}
