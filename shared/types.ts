export type AccountType = 'checking' | 'savings' | 'investment' | 'retirement'
export type Kind = 'purchase' | 'income' | 'reimbursement' | 'transfer'

export interface Account {
  id: number
  name: string
  type: AccountType
  opening_cents: number
  in_net_worth: number
  archived: number
  sort: number
}

export interface Category {
  id: number
  name: string
  /** Tag colour, as #rrggbb. */
  color: string
  archived: number
}

export interface Tx {
  id: number
  date: string
  /** YYYY-MM the entry counts in: the month it went through checking, which can differ from its date. */
  month: string
  account_id: number
  account_name: string
  /** Signed: negative is money leaving the account. */
  amount_cents: number
  kind: Kind
  description: string
  category_id: number | null
  category_name: string | null
  category_color: string | null
  one_off: number
  cleared: number
  transfer_id: string | null
  /** Other side of a transfer; null for payroll contributions. */
  other_account_name: string | null
  reimburses_id: number | null
  reimburses_description: string | null
  reimburses_date: string | null
  /** Total of reimbursements linked to this purchase. */
  reimbursed_cents: number
}

/** What the client sends: amounts are positive as typed, the server applies the sign. */
export interface TxInput {
  kind: Exclude<Kind, 'transfer'>
  date: string
  /** Defaults to the month of the date. */
  month?: string
  account_id: number
  amount_cents: number
  description: string
  category_id: number | null
  one_off?: boolean
  reimburses_id?: number | null
}

export interface TransferInput {
  date: string
  month?: string
  /** null means money that never touched a tracked account, such as a payroll 401k contribution. */
  from_account_id: number | null
  to_account_id: number
  amount_cents: number
  description: string
}

export interface Snapshot {
  id: number
  account_id: number
  date: string
  balance_cents: number
}

export interface Goal {
  id: number
  name: string
  target_cents: number
  target_date: string
  /** Empty means every account counted in net worth. */
  account_ids: number[]
}

export interface MerchantRule {
  id: number
  pattern: string
  is_regex: number
  merchant: string
}

export interface Bootstrap {
  accounts: Account[]
  categories: Category[]
  descriptions: { description: string; category_id: number | null; account_id: number }[]
}

export interface MonthSummary {
  month: string
  /** Regular income; one-off income (a tax refund, a bonus) is counted separately. */
  income_cents: number
  one_off_income_cents: number
  spending_cents: number
  one_off_cents: number
  categories: { category_id: number | null; name: string; color: string; cents: number }[]
  moved: { savings: number; investment: number; retirement: number }
  accounts: {
    id: number
    name: string
    type: AccountType
    balance_cents: number
    uncleared: number
    snapshot: { date: string; balance_cents: number; computed_cents: number } | null
  }[]
}

export interface YearSummary {
  year: number
  months: string[]
  categories: { category_id: number | null; name: string; color: string; cents: number[] }[]
  one_off: number[]
  income: number[]
  one_off_income: number[]
  /** `paycheck` is the part of `cents` deducted before pay arrived (401k), so it is not out of take-home income. */
  contributions: { account_id: number; name: string; type: AccountType; cents: number[]; paycheck: number[] }[]
}

export interface NetWorth {
  accounts: Account[]
  snapshots: Snapshot[]
  series: { date: string; total: number; non_retirement: number }[]
  goals: (Goal & { current_cents: number })[]
}

export interface MerchantGroup {
  merchant: string
  matched_rule: boolean
  cents: number
  count: number
  first: string
  last: string
  items: { id: number; date: string; description: string; cents: number; category_name: string | null }[]
}
