/**
 * Unit tests for error handling
 */
import { describe, test, expect } from "bun:test"

import { HTTPError, isAuthError, formatErrorResponse } from "../src/lib/error"

describe("HTTPError", () => {
  test("creates error with message and response", () => {
    const response = new Response("Forbidden", { status: 403 })
    const error = new HTTPError("Access denied", response)

    expect(error.message).toBe("Access denied")
    expect(error.response).toBe(response)
    expect(error.response.status).toBe(403)
  })

  test("extends Error", () => {
    const response = new Response("Error", { status: 500 })
    const error = new HTTPError("Test error", response)

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(HTTPError)
  })
})

describe("isAuthError", () => {
  test("returns true for 401 status", () => {
    const response = new Response("Unauthorized", { status: 401 })
    const error = new HTTPError("Auth failed", response)

    expect(isAuthError(error)).toBe(true)
  })

  test("returns true for 403 status", () => {
    const response = new Response("Forbidden", { status: 403 })
    const error = new HTTPError("Access denied", response)

    expect(isAuthError(error)).toBe(true)
  })

  test("returns false for 404 status", () => {
    const response = new Response("Not found", { status: 404 })
    const error = new HTTPError("Not found", response)

    expect(isAuthError(error)).toBe(false)
  })

  test("returns false for 500 status", () => {
    const response = new Response("Server error", { status: 500 })
    const error = new HTTPError("Server error", response)

    expect(isAuthError(error)).toBe(false)
  })

  test("returns false for regular Error", () => {
    const error = new Error("Regular error")

    expect(isAuthError(error)).toBe(false)
  })
})

describe("formatErrorResponse", () => {
  test("formats HTTPError with JSON body", async () => {
    const jsonBody = JSON.stringify({ error: { message: "Test error" } })
    const response = new Response(jsonBody, { status: 400 })
    const error = new HTTPError("Bad request", response)

    const result = await formatErrorResponse(error)

    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: { message: "Test error" } })
  })

  test("formats HTTPError with non-JSON body", async () => {
    const response = new Response("Plain text error", { status: 400 })
    const error = new HTTPError("Bad request", response)

    const result = await formatErrorResponse(error)

    expect(result.status).toBe(400)
    expect(result.body).toEqual({
      error: {
        message: "Plain text error",
        type: "error",
      },
    })
  })

  test("formats regular Error", async () => {
    const error = new Error("Something went wrong")

    const result = await formatErrorResponse(error)

    expect(result.status).toBe(500)
    expect(result.body).toEqual({
      error: {
        message: "Something went wrong",
        type: "error",
      },
    })
  })

  test("includes cause in regular error", async () => {
    const error = new Error("Outer error")
    error.cause = "Inner cause"

    const result = await formatErrorResponse(error)

    expect(result.status).toBe(500)
    expect(result.body).toEqual({
      error: {
        message: "Outer error",
        type: "error",
      },
    })
  })

  test("handles empty response body", async () => {
    const response = new Response("", { status: 500 })
    const error = new HTTPError("Server error", response)

    const result = await formatErrorResponse(error)

    expect(result.status).toBe(500)
    expect(result.body).toEqual({
      error: {
        message: "",
        type: "error",
      },
    })
  })

  test("preserves original status codes", async () => {
    const statuses = [400, 401, 403, 404, 422, 500, 502, 503]

    for (const status of statuses) {
      const response = new Response("Error", { status })
      const error = new HTTPError("Error", response)

      const result = await formatErrorResponse(error)

      expect(result.status).toBe(status)
    }
  })
})
