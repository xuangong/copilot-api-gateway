import { describe, expect, it } from 'bun:test'
import { runDirectConnectRequest, runProxiedRequest } from '../dialer.ts'
import { makeFakeSocketDial } from './test-utils/fake-socket-dial.ts'
import type { DialedSocket, SocketDial } from '../types.ts'

const enc = new TextEncoder()
const until = async (check: () => boolean): Promise<void> => {
  for (let n = 0; n < 1000; n++) { if (check()) return; await Bun.sleep(1) }
  throw new Error('controlled event did not arrive')
}
const target = { host: 'example.test', port: 80, tls: false }
const request = { method: 'GET', path: '/', headers: { Host: 'example.test' } }

const trackedDial = () => {
  const fake = makeFakeSocketDial()
  let closes = 0
  const socketDial: SocketDial = {
    async connect(host, port, options) {
      const socket = await fake.socketDial.connect(host, port, options)
      return { ...socket, async close() { closes++; await socket.close() } } satisfies DialedSocket
    },
  }
  return { fake, socketDial, closes: () => closes }
}

describe('raw request socket lifetime', () => {
  it('closes direct concrete socket after response EOF', async () => {
    const tracked = trackedDial()
    const response = runDirectConnectRequest(target, request, { socketDial: tracked.socketDial })
    const server = await tracked.fake.awaitConnect()
    await until(() => new TextDecoder().decode(server.peekWritten()).includes('\r\n\r\n'))
    server.respond('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n')
    const result = await response
    expect(tracked.closes()).toBe(0)
    server.respond(enc.encode('done'))
    expect(await result.text()).toBe('done')
    expect(tracked.closes()).toBe(1)
  })

  it('closes proxied concrete socket after response cancellation', async () => {
    const tracked = trackedDial()
    const response = runProxiedRequest(
      { kind: 'http', name: 'fixture', host: 'proxy.test', port: 3128, tls: false },
      target,
      request,
      { socketDial: tracked.socketDial },
    )
    const server = await tracked.fake.awaitConnect()
    await until(() => new TextDecoder().decode(server.peekWritten()).includes('CONNECT example.test:80 HTTP/1.1\r\n'))
    server.respond('HTTP/1.1 200 Connection Established\r\n\r\n')
    await until(() => new TextDecoder().decode(server.peekWritten()).includes('GET / HTTP/1.1\r\n'))
    server.respond('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nearly-')
    const result = await response
    expect(result.status).toBe(200)
    expect(tracked.closes()).toBe(0)
    await result.body?.cancel('consumer stopped')
    await until(() => tracked.closes() === 1)
  })

  it('closes the socket on a failed proxy handshake', async () => {
    const tracked = trackedDial()
    const response = runProxiedRequest(
      { kind: 'http', name: 'fixture', host: 'proxy.test', port: 3128, tls: false },
      target,
      request,
      { socketDial: tracked.socketDial },
    )
    const server = await tracked.fake.awaitConnect()
    server.respond('HTTP/1.1 407 Authentication Required\r\n\r\n')
    await expect(response).rejects.toHaveProperty('stage', 'proxy-handshake')
    expect(tracked.closes()).toBeGreaterThanOrEqual(1)
  })
})
