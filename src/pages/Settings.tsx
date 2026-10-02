import { useState } from 'react'
import type { BackupStatus } from '../../server/backup.ts'
import { useLoad } from '../hooks.ts'
import { parseAmount } from '../../shared/parse.ts'
import type { Account, AccountType, Category } from '../../shared/types.ts'
import { api } from '../api.ts'
import { useData } from '../App.tsx'

const TYPES: [AccountType, string][] = [
  ['checking', 'Checking'], ['savings', 'Savings'], ['investment', 'Investment'], ['retirement', 'Retirement'],
]

function AccountRow({ account, onChanged }: { account: Account; onChanged: () => void }) {
  const [name, setName] = useState(account.name)
  const [opening, setOpening] = useState((account.opening_cents / 100).toFixed(2))
  const [error, setError] = useState('')
  const tracked = account.type === 'checking'

  async function patch(body: Partial<Account>) {
    try {
      await api('PATCH', `/api/accounts/${account.id}`, body)
      setError('')
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <tr className={account.archived ? 'archived' : ''}>
      <td>
        <input value={name} aria-label="Account name" onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== account.name && void patch({ name })} />
        {error && <div className="error">{error}</div>}
      </td>
      <td>
        <select value={account.type} aria-label="Account type" onChange={(e) => void patch({ type: e.target.value as AccountType })}>
          {TYPES.map(([t, label]) => <option key={t} value={t}>{label}</option>)}
        </select>
      </td>
      <td>
        {tracked && (
          <input className="num" inputMode="decimal" aria-label="Starting balance" value={opening} onChange={(e) => setOpening(e.target.value)}
            onBlur={() => {
              const cents = parseAmount(opening)
              if (cents === null) return setError('Starting balance must be an amount')
              if (cents !== account.opening_cents) void patch({ opening_cents: cents })
            }} />
        )}
      </td>
      <td className="center"><input type="checkbox" aria-label="Count in net worth" checked={!!account.in_net_worth} onChange={(e) => void patch({ in_net_worth: e.target.checked ? 1 : 0 })} /></td>
      <td className="actions">
        <button type="button" onClick={() => void patch({ archived: account.archived ? 0 : 1 })}>{account.archived ? 'Restore' : 'Archive'}</button>
      </td>
    </tr>
  )
}

function CategoryRow({ category, onChanged }: { category: Category; onChanged: () => void }) {
  const [name, setName] = useState(category.name)
  const patch = (body: Partial<Category>) => api('PATCH', `/api/categories/${category.id}`, body).then(onChanged)
  return (
    <li className={category.archived ? 'archived' : ''}>
      <input type="color" value={category.color} aria-label={`Colour for ${category.name}`} onChange={(e) => void patch({ color: e.target.value })} />
      <input value={name} aria-label="Category name" onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== category.name && void patch({ name })} />
      <button type="button" onClick={() => void patch({ archived: category.archived ? 0 : 1 })}>{category.archived ? 'Restore' : 'Archive'}</button>
    </li>
  )
}

function Backup() {
  const { data, reload } = useLoad<BackupStatus | null>('/api/backup')
  const [dir, setDir] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (!data) return null
  const value = dir ?? data.extraDir

  async function save(extraDir?: string) {
    setBusy(true)
    try {
      await api('POST', '/api/backup', extraDir === undefined ? {} : { extraDir })
      setDir(null)
      setError('')
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }
  return (
    <>
      <h3>Second backup folder</h3>
      <p className="muted small">
        The daily copy is also written here, so it survives this Mac. Use a folder in iCloud Drive or on an external drive.
        Today's copy is refreshed when the app starts, every half hour while it runs, and when you stop it.
      </p>
      <form className="fields" onSubmit={(e) => { e.preventDefault(); void save(value) }}>
        <label className="grow">Folder<input value={value} onChange={(e) => setDir(e.target.value)} placeholder="Not set" spellCheck={false} /></label>
        {data.icloudDir && value !== data.icloudDir && <button type="button" onClick={() => void save(data.icloudDir)}>Use iCloud Drive</button>}
        <button type="submit" disabled={busy}>Save</button>
        <button type="button" disabled={busy} onClick={() => void save()}>Back up now</button>
      </form>
      {data.extraDir && !data.error && data.lastRun && (
        <p className="status good"><span>✓ Backed up to both folders</span> at {new Date(data.lastRun).toLocaleString()}</p>
      )}
      {data.error && <p className="error" role="alert">⚠ Could not write to the second folder: {data.error}</p>}
      {!data.extraDir && <p className="muted small">Not set: backups are only on this Mac.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  )
}

export function Settings() {
  const { accounts, categories, reload } = useData()
  const [account, setAccount] = useState({ name: '', type: 'savings' as AccountType })
  const [category, setCategory] = useState('')
  const [error, setError] = useState('')

  async function add(url: string, body: unknown, reset: () => void) {
    try {
      await api('POST', url, body)
      reset()
      setError('')
      void reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <>
      <div className="heading"><h1>Settings</h1></div>
      {error && <p className="error" role="alert">{error}</p>}
      <section className="card">
        <h2>Accounts</h2>
        <p className="muted small">
          The starting balance is what a checking account held before the first entry you record for it.
        </p>
        <div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Name</th><th>Type</th><th>Starting balance</th><th>In net worth</th><th /></tr></thead>
            <tbody>{accounts.map((a) => <AccountRow key={a.id} account={a} onChanged={() => void reload()} />)}</tbody>
          </table>
        </div>
        <form className="fields" onSubmit={(e) => { e.preventDefault(); void add('/api/accounts', account, () => setAccount({ name: '', type: 'savings' })) }}>
          <label className="grow">New account<input value={account.name} onChange={(e) => setAccount({ ...account, name: e.target.value })} placeholder="Name" /></label>
          <label>Type
            <select value={account.type} onChange={(e) => setAccount({ ...account, type: e.target.value as AccountType })}>
              {TYPES.map(([t, label]) => <option key={t} value={t}>{label}</option>)}
            </select>
          </label>
          <button type="submit">Add account</button>
        </form>
      </section>
      <section className="card">
        <h2>Categories</h2>
        <p className="muted small">Each category has a tag colour, used wherever it appears.</p>
        <ul className="categories">{categories.map((c) => <CategoryRow key={c.id} category={c} onChanged={() => void reload()} />)}</ul>
        <form className="fields" onSubmit={(e) => { e.preventDefault(); void add('/api/categories', { name: category }, () => setCategory('')) }}>
          <label className="grow">New category<input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Name" /></label>
          <button type="submit">Add category</button>
        </form>
      </section>
      <section className="card">
        <h2>Your data</h2>
        <p>Everything is stored in <code>data/spend.sqlite</code> inside the project folder, with a dated copy in <code>data/backups</code> each day you open the app. Nothing is sent anywhere unless you set a second backup folder below.</p>
        <a className="button" href="/api/export.csv">Download all transactions as CSV</a>
        <Backup />
      </section>
    </>
  )
}
