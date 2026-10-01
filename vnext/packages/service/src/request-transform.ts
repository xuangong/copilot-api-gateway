import type { Interceptor } from "./index"

export type RequestTransform<Req> = (req: Req) => undefined

export const beforeRequest = <Ctx, Req, Result>(
  transform: RequestTransform<Req>,
): Interceptor<Ctx, Req, Result> => {
  return (req, _ctx, next) => {
    try {
      transform(req)
      return next()
    } catch (error) {
      return Promise.reject(error)
    }
  }
}
