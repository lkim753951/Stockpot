import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import http from 'node:http'

/** A stand-in for Supabase Storage's REST API, keeping objects in memory. It follows the documented routes. */
export async function startStorage(serviceKey: string) {
  const objects = new Map<string, { bytes: Buffer; type: string }>()
  const state = { objects, requests: [] as string[], uploadTokens: new Set<string>(), readTokens: new Set<string>(), largestFile: Infinity, seenKeys: new Set<string>() }
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const route = decodeURIComponent(url.pathname.replace(/^\/storage\/v1/, ''))
      const body = Buffer.concat(chunks)
      const send = (status: number, payload: unknown = {}) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)) }
      state.requests.push(`${request.method} ${route}`)
      const signed = route.match(/^\/object\/sign\/([^/]+)\/(.+)$/)
      const toUpload = route.match(/^\/object\/upload\/sign\/([^/]+)\/(.+)$/)

      // The only two routes a browser may reach, and the token in the link is what lets it.
      if (request.method === 'GET' && signed) {
        if (!state.readTokens.has(url.searchParams.get('token') ?? '')) return send(400, { error: 'InvalidSignature' })
        const object = objects.get(signed[2])
        if (!object) return send(404)
        const range = String(request.headers.range ?? '').match(/^bytes=(\d+)-(\d*)$/)
        if (!range) { response.writeHead(200, { 'Content-Type': object.type, 'Accept-Ranges': 'bytes', 'Content-Length': object.bytes.length }); return response.end(object.bytes) }
        const [start, end] = [Number(range[1]), Number(range[2] || object.bytes.length - 1)]
        response.writeHead(206, { 'Content-Type': object.type, 'Content-Range': `bytes ${start}-${end}/${object.bytes.length}` })
        return response.end(object.bytes.subarray(start, end + 1))
      }
      if (request.method === 'PUT' && toUpload) {
        if (!state.uploadTokens.delete(url.searchParams.get('token') ?? '')) return send(400, { error: 'InvalidSignature' })
        objects.set(toUpload[2], { bytes: body, type: String(request.headers['content-type'] ?? 'application/octet-stream') })
        return send(200, { Key: toUpload[2] })
      }

      state.seenKeys.add(String(request.headers.apikey ?? ''))
      const allowed = serviceKey.startsWith('sb_') ? request.headers.apikey === serviceKey && !request.headers.authorization : request.headers.authorization === `Bearer ${serviceKey}`
      if (!allowed) return send(401, { error: 'Unauthorized' })
      if (request.method === 'POST' && signed) {
        const token = crypto.randomUUID()
        state.readTokens.add(token)
        return send(200, { signedURL: `/object/sign/${signed[1]}/${signed[2]}?token=${token}` })
      }
      if (request.method === 'POST' && toUpload) {
        const token = crypto.randomUUID()
        state.uploadTokens.add(token)
        return send(200, { url: `/object/upload/sign/${toUpload[1]}/${toUpload[2]}?token=${token}`, token })
      }
      if (request.method === 'POST' && route === '/object/move') {
        const { sourceKey, destinationKey } = JSON.parse(body.toString())
        const object = objects.get(sourceKey)
        if (!object) return send(404)
        objects.set(destinationKey, object)
        objects.delete(sourceKey)
        return send(200, { message: 'Successfully moved' })
      }
      if (request.method === 'POST' && route.startsWith('/object/list/')) {
        const { prefix } = JSON.parse(body.toString())
        return send(200, [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ name: key.slice(prefix.length) })))
      }
      const plain = route.match(/^\/object\/([^/]+)\/(.+)$/)
      if (request.method === 'DELETE' && /^\/object\/[^/]+$/.test(route)) {
        const { prefixes } = JSON.parse(body.toString())
        for (const key of prefixes) objects.delete(key)
        return send(200, [])
      }
      if (!plain) return send(404)
      if (request.method === 'POST') {
        // The free plan's limit, which a long call can run into.
        if (body.length > state.largestFile) return send(413, { error: 'Payload too large' })
        objects.set(plain[2], { bytes: body, type: String(request.headers['content-type'] ?? 'application/octet-stream') })
        return send(200, { Key: plain[2] })
      }
      const object = objects.get(plain[2])
      // Storage answers a missing object with a 400 that says 404 inside it.
      if (!object) return send(400, { statusCode: '404', error: 'not_found' })
      if (request.method === 'HEAD') { response.writeHead(200); return response.end() }
      response.writeHead(200, { 'Content-Type': object.type })
      response.end(object.bytes)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    state,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }),
  }
}

/** Starts another server process and gives its address. */
export function startInstance(env: Record<string, string | undefined> = {}) {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'test/instance.ts'], { env: { ...process.env, NODE_TEST_CONTEXT: undefined, ...env }, stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise<{ base: string; ws: string; child: ChildProcess; kill: () => void }>((resolve, reject) => {
    let text = ''
    child.once('exit', (code) => reject(new Error(`The second instance stopped with code ${code}`)))
    child.stdout!.on('data', (chunk) => {
      text += String(chunk)
      const found = text.match(/\{"port":(\d+)\}/)
      if (found) resolve({ base: `http://127.0.0.1:${found[1]}`, ws: `ws://127.0.0.1:${found[1]}`, child, kill: () => child.kill('SIGKILL') })
    })
  })
}
