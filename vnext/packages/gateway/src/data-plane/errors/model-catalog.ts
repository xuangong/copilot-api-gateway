import { HTTPException } from 'hono/http-exception'
import { geminiErrorBody } from './forward.ts'

export const MODEL_CATALOG_UNAVAILABLE = 'Model catalog is temporarily unavailable. Please retry later.'

/**
 * The 503 for a model no loaded catalog lists while some catalog failed. Names
 * the model and how many catalogs failed, never which upstreams: callers may
 * not own them. Operators find the upstream IDs in the routing warning.
 */
export function modelCatalogUnavailableMessage(model: string, failedCatalogs: number): string {
  // This message only exists because some catalog failed, even when the
  // enumerator could not say which (the upstream list itself, or a mock).
  const count = Math.max(1, failedCatalogs)
  const catalogs = count === 1 ? "1 upstream catalog" : `${count} upstream catalogs`
  return `Model catalog is temporarily unavailable: ${model} is not in any catalog that loaded, and ${catalogs} could not be loaded. Please retry later.`
}

/** For routes without an attempt/result renderer (catalogs, embeddings, images). */
export class ModelCatalogUnavailableError extends HTTPException {
  constructor(format?: 'gemini') {
    super(503, {
      message: MODEL_CATALOG_UNAVAILABLE,
      res: Response.json(
        format === 'gemini'
          ? geminiErrorBody(503, MODEL_CATALOG_UNAVAILABLE)
          : { error: { type: 'api_error', message: MODEL_CATALOG_UNAVAILABLE } },
        { status: 503 },
      ),
    })
  }
}
