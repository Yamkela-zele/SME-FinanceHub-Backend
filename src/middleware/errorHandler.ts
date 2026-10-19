import type { ErrorRequestHandler } from "express"
import multer from "multer"
import { HttpError } from "../utils/httpError.js"

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Evidence files must be no larger than 10 MB" : "Invalid evidence upload" })
    return
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error(err)
  res.status(500).json({ error: "Internal server error" })
}
