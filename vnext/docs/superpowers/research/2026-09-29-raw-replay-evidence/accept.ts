import net from 'node:net'
import tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { bunSocketDial } from '../../../../apps/platform-bun/src/bun-socket-dial.ts'
import { fetchOnStream } from '../../../../packages/http/src/fetch-on-stream.ts'
import { userspaceTls } from '../../../../packages/http/src/tls.ts'
import type { ReplayableBody } from '../../../../packages/platform/src/replayable-body.ts'

for (const encrypted of [false, true]) for (const status of [200, 413]) {
  let serverSocket: net.Socket | undefined
  const serve = (socket: net.Socket): void => {
    serverSocket = socket
    socket.on('error', () => {})
    let head = ''
    socket.on('data', data => {
      head += data.toString()
      if (!head.includes('\r\n\r\n')) return
      socket.removeAllListeners('data')
      socket.pause()
      socket.write(`HTTP/1.1 ${status} Early\r\nContent-Length: 10\r\nConnection: close\r\n\r\nearly-`)
      setTimeout(() => socket.write('tail'), 100)
    })
  }
  const directory = process.env.B05_TLS_FIXTURE_DIR ?? import.meta.dir
  const server = encrypted
    ? tls.createServer({ key: readFileSync(`${directory}/local-key.pem`), cert: readFileSync(`${directory}/local-cert.pem`), minVersion: 'TLSv1.3' }, serve)
    : net.createServer(serve)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing port')
  const socket = await bunSocketDial.connect('127.0.0.1', address.port)
  // The insecure option is confined to this self-signed loopback test fixture.
  const stream = encrypted ? await userspaceTls(socket, { host: 'localhost', insecure: true }) : socket
  let generated = 0, cancelled = 0, closes = 0
  const replay: ReplayableBody = {
    kind: 'replayable', contentLength: 100_000_000,
    open() {
      return new ReadableStream<Uint8Array>({
        pull(controller) { generated += 65536; controller.enqueue(new Uint8Array(65536)) },
        cancel() { cancelled++ },
      }, { highWaterMark: 0 })
    },
  }
  const response = await fetchOnStream(
    stream,
    { method: 'POST', path: '/', headers: { Host: 'localhost' }, body: replay },
    undefined,
    { closeTransport() { closes++; return socket.close() } },
  )
  const statusSeen = response.status
  const content = await response.text()
  if (statusSeen !== status || content !== 'early-tail' || cancelled !== 1 || closes !== 1 || stream.writable.locked) {
    throw new Error(JSON.stringify({ encrypted, status, statusSeen, content, generated, cancelled, closes, locked: stream.writable.locked }))
  }
  console.log(JSON.stringify({ encrypted, status, statusSeen, content, generated, cancelled, closes }))
  serverSocket?.destroy()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
