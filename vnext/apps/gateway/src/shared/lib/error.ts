export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export function isAuthError(error: Error): boolean {
  if (error instanceof HTTPError) {
    return error.response.status === 401 || error.response.status === 403
  }
  return false
}

interface ErrorResponseBody {
  error: {
    message: string
    type: string
  }
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export async function formatErrorResponse(error: Error): Promise<{
  body: ErrorResponseBody | { [key: string]: JsonValue }
  status: number
}> {
  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    console.error(
      `[${error.response.status}] ${error.message}: ${errorText.slice(0, 500)}`,
    )

    // Try to parse as JSON
    try {
      const errorJson = JSON.parse(errorText) as { [key: string]: JsonValue }
      return { body: errorJson, status: error.response.status }
    } catch {
      return {
        body: {
          error: {
            message: errorText,
            type: "error",
          },
        },
        status: error.response.status,
      }
    }
  }

  const cause = error.cause ? ` (cause: ${String(error.cause)})` : ""
  console.error(`${error.message}${cause}`)

  return {
    body: {
      error: {
        message: error.message,
        type: "error",
      },
    },
    status: 500,
  }
}
