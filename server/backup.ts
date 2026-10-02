import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DB } from './db.ts'

export interface BackupStatus {
  /** Second folder that also receives the daily copy, such as one in iCloud Drive. Empty when unset. */
  extraDir: string
  /** Suggested iCloud Drive folder, or empty if iCloud Drive is not set up on this Mac. */
  icloudDir: string
  lastRun: string | null
  /** Why the last copy to the second folder failed, if it did. */
  error: string | null
}

const ICLOUD = path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs')
const KEEP = 30

/**
 * Keeps one dated copy of the database per day in data/backups, and in a second folder if one is
 * set. Today's copy is refreshed on start, every half hour and on exit, so it holds the day's entries.
 */
export function createBackups(db: DB, dataDir: string) {
  const configFile = path.join(dataDir, 'config.json')
  const localDir = path.join(dataDir, 'backups')
  let extraDir = ''
  try {
    extraDir = (JSON.parse(fs.readFileSync(configFile, 'utf8')) as { extraBackupDir?: string }).extraBackupDir ?? ''
  } catch {
    // No config yet: local backups only.
  }
  let lastRun: string | null = null
  let error: string | null = null
  let running: Promise<void> | null = null

  async function copyTo(dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    const today = new Date().toLocaleDateString('en-CA')
    // Write beside the target, then swap, so a sync client never uploads a half-written file.
    const target = path.join(dir, `spend-${today}.sqlite`)
    const partial = `${target}.partial`
    await db.backup(partial)
    fs.renameSync(partial, target)
    const old = fs.readdirSync(dir).filter((f) => /^spend-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0, -KEEP)
    for (const f of old) fs.rmSync(path.join(dir, f))
  }

  async function run() {
    await copyTo(localDir)
    error = null
    if (extraDir) {
      try {
        await copyTo(extraDir)
      } catch (e) {
        error = (e as Error).message
      }
    }
    lastRun = new Date().toISOString()
  }

  return {
    /** Runs one backup at a time; a call during a run waits for that run. */
    run: () => (running ??= run().finally(() => { running = null })),
    status: (): BackupStatus => ({ extraDir, icloudDir: fs.existsSync(ICLOUD) ? path.join(ICLOUD, 'Spend Tracker Backups') : '', lastRun, error }),
    setExtraDir(dir: string) {
      extraDir = dir.trim().replace(/^~(?=\/|$)/, os.homedir())
      fs.writeFileSync(configFile, JSON.stringify({ extraBackupDir: extraDir }, null, 2))
    },
  }
}
export type Backups = ReturnType<typeof createBackups>
