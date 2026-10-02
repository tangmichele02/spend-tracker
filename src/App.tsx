import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { Bootstrap } from '../shared/types.ts'
import { api } from './api.ts'
import { currentMonth, MIN_YEAR } from './format.ts'
import { Companies } from './pages/Companies.tsx'
import { Import } from './pages/Import.tsx'
import { Month } from './pages/Month.tsx'
import { NetWorthPage } from './pages/NetWorth.tsx'
import { Savings } from './pages/Savings.tsx'
import { Settings } from './pages/Settings.tsx'
import { Spending } from './pages/Spending.tsx'
import { Transactions } from './pages/Transactions.tsx'

interface AppData extends Bootstrap {
  reload: () => Promise<void>
}
const DataContext = createContext<AppData | null>(null)
export const useData = () => useContext(DataContext)!

const NAV = [
  ['month', 'Month'],
  ['transactions', 'Transactions'],
  ['spending', 'Spending'],
  ['savings', 'Savings'],
  ['networth', 'Net worth'],
  ['companies', 'Companies'],
  ['import', 'Import'],
  ['settings', 'Settings'],
] as const

function useHashRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onChange = () => setRoute(read())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function App() {
  const [data, setData] = useState<Bootstrap | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    try {
      setData(await api<Bootstrap>('GET', '/api/bootstrap'))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => { void reload() }, [reload])
  const [page = 'month', arg] = useHashRoute()

  if (error) return <p className="page error">Could not reach the app server: {error}</p>
  if (!data) return null

  return (
    <DataContext.Provider value={{ ...data, reload }}>
      <header className="topbar">
        <strong>Spend Tracker</strong>
        <nav>
          {NAV.map(([key, label]) => (
            <a key={key} href={`#/${key}`} className={page === key ? 'active' : ''}>{label}</a>
          ))}
        </nav>
      </header>
      <main className="page">
        {page === 'month' && <Month month={/^\d{4}-(0[1-9]|1[0-2])$/.test(arg ?? '') && arg >= `${MIN_YEAR}-01` ? arg : currentMonth()} />}
        {page === 'transactions' && <Transactions key={arg ?? ''} kind={arg} />}
        {page === 'spending' && <Spending />}
        {page === 'savings' && <Savings />}
        {page === 'networth' && <NetWorthPage />}
        {page === 'companies' && <Companies />}
        {page === 'import' && <Import month={/^\d{4}-(0[1-9]|1[0-2])$/.test(arg ?? '') ? arg : undefined} />}
        {page === 'settings' && <Settings />}
      </main>
    </DataContext.Provider>
  )
}
