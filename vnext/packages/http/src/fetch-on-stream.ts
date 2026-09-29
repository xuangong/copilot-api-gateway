// Run an HTTP/1.1 request over an already-established duplex byte stream.

import { concat, utf8Bytes } from './bytes.ts';
import { HttpProtocolError } from './errors.ts';
import { TCHAR, validateFieldValueBytes, validateRequestTargetBytes } from './grammar.ts';
import { parseHttpResponse, toWebResponse } from './parser.ts';
import { signalAbortReason } from './abort.ts';
import { assertReplayBodyLength, isReplayableBody, ReplayBodyError } from '@vibe-core/platform';
import type { DuplexStream, HttpRequest } from './types.ts';

// Plaintext chunk size used when streaming the request body to the writer.
// Each writer.write() maps 1:1 to one record on a record-framed writer, so
// this tunes the trade-off between per-record overhead and per-write
// microtask cost.
const BODY_WRITE_CHUNK_SIZE = 16384;

export interface FetchOnStreamOptions {
  signal?: AbortSignal;
  /** Idempotently closes the concrete socket, even when stream halves are locked. */
  closeTransport: (reason?: unknown) => void | Promise<void>;
}

export const fetchOnStream = async (
  stream: DuplexStream,
  request: HttpRequest,
  prefix: Uint8Array | undefined,
  options: FetchOnStreamOptions,
): Promise<Response> => {
  if (!options || typeof options.closeTransport !== 'function') {
    throw new TypeError('fetchOnStream requires a concrete closeTransport callback');
  }
  if (options.signal?.aborted) throw signalAbortReason(options.signal);
  // RFC 9110 §6.4.1: a HEAD response carries no body even when
  // Content-Length is set. Detecting that here is a one-line carve-out,
  // but the chunked/length body parsers below would otherwise hang
  // waiting for body bytes that the server is not sending — so refuse
  // HEAD outright at this layer. Callers that need HEAD can build the
  // response themselves off the headers we'd parse.
  if (request.method.toUpperCase() === 'HEAD') {
    throw new HttpProtocolError(
      'HEAD requests are not supported by this layer',
      'HEAD_REQUEST_REJECTED',
      { rfc: 'RFC 9110 §6.4.1' },
    );
  }

  // RFC 9110 §9.1: the method is a token. The same anti-smuggling rationale
  // as header names applies — a CR/LF/SP smuggled into the method would split
  // the request line and inject a forged head onto the wire.
  if (!TCHAR.test(request.method)) {
    throw new HttpProtocolError(
      `caller-supplied method is not a valid token: ${JSON.stringify(request.method)}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9110 §9.1' },
    );
  }
  validateRequestTargetBytes(
    request.path,
    () => new HttpProtocolError(
      'caller-supplied path is empty',
      'BAD_HEADERS',
      { rfc: 'RFC 9112 §3.2' },
    ),
    hex => new HttpProtocolError(
      `caller-supplied path contains a forbidden byte 0x${hex}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9112 §3.2' },
    ),
  );

  // Normalize the request header block in a single pass:
  //   - drop Content-Length / Transfer-Encoding — the local body's
  //     exact length is the source of truth at this layer, and a chunked
  //     encoding from the runtime fetch path would leave the body wrapped
  //     in chunk markers we cannot decode here.
  //   - drop any Connection case-variant — this layer is one-shot per
  //     duplex (we always emit Connection: close below) and a caller-
  //     supplied `keep-alive` would mislead the upstream into reusing a
  //     transport we plan to tear down.
  //   - track whether Accept-Encoding is set so we can default it to
  //     `identity` below without a second pass over the header map.
  //   - validate every name/value the caller passes through so a
  //     ${k}: ${v}\r\n serialization can't smuggle a fresh header line
  //     onto the wire.
  // Validation runs before getWriter() so a forbidden byte rejects without
  // ever taking the writer lock — otherwise a pre-write throw would leave
  // the lock pinned and the caller's writable.abort() would TypeError.
  const headers: Record<string, string> = {};
  let hasAcceptEncoding = false;
  for (const [k, v] of Object.entries(request.headers)) {
    if (!TCHAR.test(k)) {
      throw new HttpProtocolError(
        `caller-supplied header name is not a valid token: ${JSON.stringify(k)}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9110 §5.6.2' },
      );
    }
    validateFieldValueBytes(v, hex => new HttpProtocolError(
      `caller-supplied header value for ${JSON.stringify(k)} contains a forbidden control byte 0x${hex}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9110 §5.5' },
    ));
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection') continue;
    if (lk === 'accept-encoding') hasAcceptEncoding = true;
    headers[k] = v;
  }
  headers.Connection = 'close';
  if (!hasAcceptEncoding) headers['Accept-Encoding'] = 'identity';
  // Without Content-Length on a body-bearing request, RFC 9112 §6 has the
  // server treat the message as zero-length — a serialized POST emitted
  // with no framing at all silently loses its body on strict upstreams.
  const replayBody = isReplayableBody(request.body) ? request.body : undefined;
  if (replayBody) assertReplayBodyLength(replayBody.contentLength);
  const bodyLen = replayBody?.contentLength ?? (request.body instanceof Uint8Array ? request.body.byteLength : 0);
  if (bodyLen > 0 || replayBody) headers['Content-Length'] = String(bodyLen);

  const requestLine = `${request.method} ${request.path} HTTP/1.1\r\n`;
  let head = requestLine;
  for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
  head += '\r\n';
  const headBytes = utf8Bytes(head);

  const transportReader = stream.readable.getReader();
  let readerReleased = false;
  const releaseTransportReader = (): void => {
    if (readerReleased) return;
    try { transportReader.releaseLock(); readerReleased = true; } catch { /* a read is still pending */ }
  };
  const parserInput = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let terminal = false;
      try {
        const result = await transportReader.read();
        if (result.done) {
          terminal = true;
          try { controller.close(); } catch { /* cancelled while read was pending */ }
        } else {
          try { controller.enqueue(result.value); }
          catch { terminal = true; /* cancelled while read was pending */ }
        }
      } catch (error) {
        terminal = true;
        try { controller.error(error); } catch { /* already cancelled */ }
      } finally {
        if (terminal) releaseTransportReader();
      }
    },
    async cancel(reason) {
      try { await transportReader.cancel(reason); }
      finally { releaseTransportReader(); }
    },
  }, { highWaterMark: 0 });
  let writer: WritableStreamDefaultWriter<Uint8Array>;
  try { writer = stream.writable.getWriter(); }
  catch (error) { releaseTransportReader(); throw error; }
  let source: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let state: 'uploading' | 'upload-complete' | 'remote-final' | 'failed' = 'uploading';
  let failure: unknown;
  let delivered = false;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const responseReaderRef: { current?: ReadableStreamDefaultReader<Uint8Array> } = {};
  let parsedResponse: Response | undefined;
  let sourceCancel: Promise<void> | undefined;
  const releaseResponseReader = (): void => {
    try { responseReaderRef.current?.releaseLock(); } catch { /* a read is still pending */ }
  };
  let closePromise: Promise<void> | undefined;
  const close = (reason?: unknown): Promise<void> => {
    if (!closePromise) {
      // Invoke the concrete close synchronously: it must unblock an already
      // issued write before any upload task is awaited.
      let concreteClose: Promise<void>;
      try { concreteClose = Promise.resolve(options.closeTransport(reason)); }
      catch (error) { concreteClose = Promise.reject(error); }
      const cancelRead = transportReader.cancel(reason);
      closePromise = Promise.allSettled([concreteClose, cancelRead]).then(() => { releaseTransportReader(); });
      void closePromise.catch(() => {});
    }
    return closePromise;
  };
  const stopSource = (reason?: unknown): void => {
    if (source && !sourceCancel) {
      sourceCancel = source.cancel(reason);
      void sourceCancel.catch(() => {});
    }
  };
  const fail = (error: unknown): void => {
    if (state === 'failed' || state === 'remote-final') return;
    state = 'failed';
    failure = error;
    void close(error);
    stopSource(error);
  };
  let rejectAbort: (reason: unknown) => void = () => {};
  const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  void abortPromise.catch(() => {});
  const onAbort = (): void => {
    const signal = options.signal;
    if (!signal) return;
    const reason = signalAbortReason(signal);
    fail(reason);
    void close(reason);
    stopSource(reason);
    if (delivered) {
      try { bodyController?.error(reason); } catch { /* body already ended */ }
      if (responseReaderRef.current) {
        void responseReaderRef.current.cancel(reason).then(releaseResponseReader, releaseResponseReader);
      }
    }
    rejectAbort(reason);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const upload = async (): Promise<void> => {
    try {
      await writer.write(prefix?.byteLength ? concat(prefix, headBytes) : headBytes);
      if (state !== 'uploading') return;
      if (replayBody) {
        try { source = replayBody.open(options.signal).getReader(); }
        catch (cause) { throw new ReplayBodyError('PRODUCER', 'replay body open failed', { cause }); }
        let written = 0;
        while (state === 'uploading') {
          let result: { done: boolean; value?: Uint8Array };
          try { result = await source.read(); }
          catch (cause) { throw new ReplayBodyError('PRODUCER', 'replay body read failed', { cause }); }
          if (state !== 'uploading') return;
          if (result.done) {
            if (written !== bodyLen) throw new ReplayBodyError('UNDERRUN', `replay body ended after ${written}/${bodyLen} bytes`);
            state = 'upload-complete';
            return;
          }
          const chunk = result.value;
          if (!(chunk instanceof Uint8Array)) throw new ReplayBodyError('PRODUCER', 'replay body produced a non-byte chunk');
          if (chunk.byteLength > bodyLen - written) {
            throw new ReplayBodyError('OVERRUN', `replay body exceeded ${bodyLen} bytes`);
          }
          for (let off = 0; off < chunk.byteLength && state === 'uploading'; off += BODY_WRITE_CHUNK_SIZE) {
            const slice = chunk.subarray(off, Math.min(off + BODY_WRITE_CHUNK_SIZE, chunk.byteLength));
            await writer.write(slice);
            if (state !== 'uploading') return;
            written += slice.byteLength;
          }
        }
      } else if (request.body instanceof Uint8Array) {
        for (let off = 0; off < request.body.byteLength && state === 'uploading'; off += BODY_WRITE_CHUNK_SIZE) {
          await writer.write(request.body.subarray(off, Math.min(off + BODY_WRITE_CHUNK_SIZE, request.body.byteLength)));
        }
      }
      if (state === 'uploading') state = 'upload-complete';
    } catch (error) {
      // The producer or writer has already failed in this continuation. Mark
      // it before `finally` yields and before a queued final-head callback can
      // claim the exchange as a successful early response.
      if (state === 'uploading' || state === 'upload-complete') fail(error);
      throw error;
    } finally {
      if (source) {
        if (state !== 'upload-complete') stopSource(failure);
        try { source.releaseLock(); } catch { /* pending cancel will settle */ }
      }
      writer.releaseLock();
    }
  };

  // Both promises have rejection observers immediately; whichever terminal
  // event is observed first sets the state before the other continuation runs.
  const uploadTask = upload();
  const uploadFailure = uploadTask.then(
    () => new Promise<never>(() => {}),
    error => {
      if (state === 'remote-final') return new Promise<never>(() => {});
      throw error;
    },
  );
  void uploadFailure.catch(() => {});
  const parsed = parseHttpResponse(parserInput).then(raw => {
    if (state === 'failed') throw failure;
    if (state === 'uploading') {
      state = 'remote-final';
      stopSource();
    }
    parsedResponse = toWebResponse(raw);
    return parsedResponse;
  }, error => {
    fail(error);
    throw error;
  });
  void parsed.catch(() => {});

  let response: Response;
  try {
    response = await Promise.race([parsed, uploadFailure, abortPromise]);
    if (options.signal?.aborted) throw signalAbortReason(options.signal);
  } catch (error) {
    fail(error);
    void close(error);
    stopSource(error);
    if (parsedResponse?.body) void parsedResponse.body.cancel(error).catch(() => {});
    options.signal?.removeEventListener('abort', onAbort);
    await Promise.allSettled([uploadTask, parsed, sourceCancel, closePromise]);
    throw error;
  }

  const finish = async (reason?: unknown): Promise<void> => {
    void close(reason);
    stopSource(reason);
    options.signal?.removeEventListener('abort', onAbort);
    await Promise.allSettled([uploadTask, sourceCancel, closePromise]);
    releaseResponseReader();
  };
  if (response.body === null) {
    await finish();
    return response;
  }
  const reader = response.body.getReader();
  responseReaderRef.current = reader;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { bodyController = controller; },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          await finish();
          controller.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        await finish(error);
        try { controller.error(error); } catch { /* abort already errored it */ }
      }
    },
    async cancel(reason) {
      void close(reason);
      await Promise.allSettled([reader.cancel(reason), finish(reason)]);
    },
  });
  delivered = true;
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};
