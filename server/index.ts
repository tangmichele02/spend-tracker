import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { exec } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createApp } from './app.ts'
import { createBackups } from './backup.ts'
import { openDb } from './db.ts'

const dev = process.argv.includes('--dev')
const port = Number(process.env.PORT ?? 4321)
const dataDir = path.resolve(process.env.SPEND_DATA_DIR ?? 'data')

const db = openDb(path.join(dataDir, 'spend.sqlite'))
const backups = createBackups(db, dataDir)
await backups.run()
setInterval(() => void backups.run(), 30 * 60 * 1000).unref()
// Refresh today's copy on the way out, so it includes everything entered this session.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void backups.run().finally(() => process.exit(0)))
}

const app = createApp(db, backups)
if (!dev) {
  app.use('/*', serveStatic({ root: './dist' }))
  app.get('*', (c) => c.html(fs.readFileSync('dist/index.html', 'utf8')))
}

// Loopback only: nothing else on the network can reach the app.
serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  const url = `http://127.0.0.1:${port}`
  console.log(`Spend Tracker running at ${url}\nData: ${dataDir}\nPress Ctrl+C to stop.`)
  // `npm start` restarts this process whenever the server code changes; open the browser only the first time.
  const marker = path.join(dataDir, '.opened')
  const firstStart = !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== String(process.ppid)
  if (!dev && process.platform === 'darwin' && !process.env.NO_OPEN && firstStart) {
    fs.writeFileSync(marker, String(process.ppid))
    exec(`open ${url}`)
  }
})
