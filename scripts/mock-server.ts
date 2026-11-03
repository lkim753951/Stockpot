// Stand-in Meta API for browser testing. Run with: npx tsx scripts/mock-server.ts
import { startMockMeta } from '../server/sample/mockMeta.ts'

const mock = await startMockMeta({ delayMs: 300 })
console.log(JSON.stringify({ httpBase: mock.httpBase, wsUrl: mock.wsUrl }))
