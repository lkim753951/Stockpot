import { waitUntil } from '@vercel/functions'
import { outsideTransaction } from './db.ts'

/**
 * Work that carries on after the reply has gone. On Vercel an instance can freeze the moment it
 * answers, so waitUntil keeps it running until this finishes, up to the function's time limit.
 * Locally it's plain fire and forget. Either way a failure is logged and goes no further.
 */
export function background(label: string, work: () => Promise<unknown>): void {
  // It may outlive the transaction that started it, so it mustn't borrow that connection.
  const running = outsideTransaction(work).catch((error) => console.error(`${label}:`, (error as Error).message))
  if (process.env.VERCEL) waitUntil(running)
}
