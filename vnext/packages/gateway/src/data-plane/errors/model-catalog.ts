import { HTTPException } from 'hono/http-exception'
import { geminiErrorBody } from './forward.ts'

export const MODEL_CATALOG_UNAVAILABLE = 'Model catalog is temporarily unavailable. Please retry later.'

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
