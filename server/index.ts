import { assertSafeToStart, config } from './core/config.ts'

// node:sqlite needs this version, and the crash without it says nothing useful.
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Stockpot needs Node 22.13 or newer. This is Node ${process.versions.node}. Run: npx -y node@22 --import tsx server/index.ts`)
  process.exit(1)
}

assertSafeToStart()

const { buildApp, startWebhookListener } = await import('./app.ts')
const { startScheduler } = await import('./core/scheduler.ts')
const server = await buildApp()
startScheduler()

if (config.whatsapp.verifyToken) startWebhookListener()

server.listen(config.port, () => {
  const running = config.mode === 'sample' ? 'sample mode, no Meta key, no AI running' : `live mode with ${config.sparkModel} and ${config.voiceModel}`
  console.log(`Stockpot on http://localhost:${config.port} (${running})`)
})
