// A second copy of the server, in its own process, on the same database. Hosted instances share nothing
// but the database and Storage, so this is how the tests prove that's enough.
const server = process.env.STOCKPOT_ENTRY === 'api'
  ? (await import('../api/index.ts')).default
  : await (await import('../server/app.ts')).buildApp()
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: (server.address() as { port: number }).port })))

export {}
