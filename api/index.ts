import { assertSafeToStart } from '../server/core/config.ts'
import { createApp } from '../server/app.ts'

// Refuses to serve at all rather than run a public site with no passcode or nowhere to keep data.
assertSafeToStart()

export default createApp()
