/** A fresh, byte-identical source for each concrete transport attempt. */
export interface ReplayableBody {
  readonly kind: "replayable"
  readonly contentLength: number
  open(signal?: AbortSignal): ReadableStream<Uint8Array>
}

export type ReplayBodyErrorCode = "INVALID_LENGTH" | "UNDERRUN" | "OVERRUN" | "PRODUCER"

export class ReplayBodyError extends Error {
  readonly code: ReplayBodyErrorCode

  constructor(code: ReplayBodyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ReplayBodyError"
    this.code = code
  }
}

export const assertReplayBodyLength = (length: number): void => {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new ReplayBodyError("INVALID_LENGTH", "replay body contentLength must be a nonnegative safe integer")
  }
}

export const isReplayableBody = (body: unknown): body is ReplayableBody =>
  typeof body === "object" && body !== null && "kind" in body && body.kind === "replayable"
