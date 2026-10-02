import { useCallback, useEffect, useState } from 'react'
import { api } from './api.ts'

/** Fetches a URL, refetching when it changes. Keeps the previous data on screen while loading. */
export function useLoad<T>(url: string): { data: T | null; error: string; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    try {
      setData(await api<T>('GET', url))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [url])
  useEffect(() => { void reload() }, [reload])
  return { data, error, reload }
}

export function stored(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
export function store(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* private window: the default is used next time */ }
}
