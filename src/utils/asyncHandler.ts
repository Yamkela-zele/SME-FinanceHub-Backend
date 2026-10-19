import type { NextFunction, Request, RequestHandler, Response } from "express"

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    void fn(req, res, next).catch(next)
