# spend-tracker

A private, local spend tracker. It runs on your Mac, stores everything in one SQLite file, and makes no network requests.

## Run it

```
npm install     # first time only
npm start
```

This builds the app, starts it at http://127.0.0.1:4321 and opens it in your browser. Press Ctrl+C in the terminal to stop it.

## Where the data lives

- `data/spend.sqlite` holds everything. `data/` is git-ignored, so it can never be committed or pushed.
- `data/backups/` gets one dated copy per day you use the app; the newest 30 are kept. Today's copy is refreshed on start, every half hour, and when you stop the app.
- Settings → "Second backup folder" writes the same copies to another folder, such as one in iCloud Drive or on an external drive, so they survive this Mac. To restore, put a backup file at `data/spend.sqlite` and run `npm start`.
- Settings → "Download all transactions as CSV" exports everything.
- The server listens on `127.0.0.1` only, so nothing else on your network can reach it.

## How it counts

- **Every entry has a month it counts in, separate from its date.** The month is the one it went through checking; the date is when it happened. A card purchase dated December 28 that was paid from checking in January is filed under January. Entries added on a Month page count in that month; on Import, "Count in month" files the whole paste under one month.
- **Purchases** are entered once paid off, against the checking account that paid. Cards and card payments are not tracked.
- **Reimbursements** linked to a purchase come off that purchase's month and category, even if the money arrives later. Unlinked ones lower their own category in the month they arrive.
- **One-off** purchases (for example taxes) are shown separately and left out of regular spending.
- **Savings, investments and retirement** are transfers into those accounts, net of anything moved out. A contribution taken from your paycheck uses "Paycheck" as the source.
- **Balances**: checking balances are computed from the starting balance (Settings) plus every entry. On the Month screen, type what the bank shows to check it.
- **Net worth** uses the balances you record on the Net worth screen; each account counts at its most recent recorded balance.

## Moving over from the spreadsheet

1. Settings: set each checking account's starting balance (the January carryover).
2. Import: for each month tab, copy the Spending table and paste it as Purchases, choosing the checking account of that tab and setting "Count in month" to the tab's month. Do the same for the Income and Reimbursement blocks. Pasting the same block twice adds nothing.
3. Net worth → Paste balances: paste the Savings Record table from the spreadsheet's Goals tab, including its header row.
4. Import → Savings, investments and 401k: for each account on the Savings tab, paste its Date and Amount columns and choose where the money came from (a checking account, or "Paycheck" for 401k and other payroll deductions).
5. Month: add Zelle moves between the two checking accounts by hand as transfers.

## Development

```
npm run dev     # API on :4321, Vite with hot reload on :5173
npm test
npm run typecheck
```

`server/` is the API (Hono + better-sqlite3), `src/` the React UI, `shared/` the types and paste parser used by both.
