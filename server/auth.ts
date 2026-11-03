import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.ts'

export type Role = 'owner' | 'staff'

const sign = (role: string) => createHmac('sha256', config.sessionSecret).update(role).digest('hex')
const same = (a: string, b: string) => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export const passcodesInUse = () => !!config.ownerPasscode

export function roleForPasscode(passcode: string): Role | null {
  if (config.ownerPasscode && same(passcode, config.ownerPasscode)) return 'owner'
  if (config.staffPasscode && same(passcode, config.staffPasscode)) return 'staff'
  return null
}

export const sessionCookie = (role: Role) =>
  `stockpot=${role}.${sign(role)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${config.production ? '; Secure' : ''}`

export function roleFromCookie(header: string | undefined): Role | null {
  // With no passcode set, the app is a local or sample build and everyone is the owner.
  if (!passcodesInUse()) return 'owner'
  const value = header?.split(/;\s*/).find((part) => part.startsWith('stockpot='))?.slice('stockpot='.length)
  if (!value) return null
  const [role, signature] = value.split('.')
  if ((role === 'owner' || role === 'staff') && signature && same(signature, sign(role))) return role
  return null
}

export const roleOf = (request: Request | IncomingMessage) => roleFromCookie(request.headers.cookie)

export function requireOwner(request: Request, response: Response, next: NextFunction) {
  const role = roleOf(request)
  if (role === 'owner') return next()
  response.status(role ? 403 : 401).json({ error: role ? 'Only the owner can see this.' : 'Sign in first.' })
}

export function requireStaff(request: Request, response: Response, next: NextFunction) {
  if (roleOf(request)) return next()
  response.status(401).json({ error: 'Sign in first.' })
}
