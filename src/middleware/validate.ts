import type { RequestHandler } from "express"
import type { ZodSchema } from "zod"

export const validateBody =
  (schema: ZodSchema): RequestHandler =>
  (req, res, next) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      res.status(400).json({ error: "Validation failed", issues: result.error.flatten().fieldErrors })
      return
    }
    req.body = result.data
    next()
  }
