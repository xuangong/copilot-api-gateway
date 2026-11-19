/** Drain an async iterable into an array. */
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}

/** The whole response body as text ("" when there is no body). */
export async function readBodyText(res: Response): Promise<string> {
  return res.body ? await res.text() : ""
}
