import type { RequestHandler } from "express"
import { prisma } from "../config/db.js"
import type { Role } from "../../../frontend/shared/types/index.js"
import { HttpError } from "../utils/httpError.js"
import { verifyToken } from "../utils/jwt.js"

const roleByDbRole: Record<"BUSINESS_OWNER" | "ACCOUNTANT" | "FUNDING_PARTNER" | "SYSTEM_ADMIN", Role> = {
  BUSINESS_OWNER: "owner",
  ACCOUNTANT: "accountant",
  FUNDING_PARTNER: "funder",
  SYSTEM_ADMIN: "admin",
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; role: Role }
    }
  }
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization
  if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required")
  try {
    const payload = verifyToken(header.slice(7))
    void prisma.user.findUnique({ where: { id: payload.sub } }).then((user) => {
      if (!user || user.status !== "ACTIVE") {
        next(new HttpError(401, "Account is not active"))
        return
      }
      if (payload.sessionVersion !== user.sessionVersion) {
        next(new HttpError(401, "Session expired. Please sign in again."))
        return
      }
      const role = roleByDbRole[user.role]
      if (payload.role !== role) {
        next(new HttpError(401, "Invalid or expired token"))
        return
      }
      req.auth = { userId: user.id, role }
      next()
    }).catch(next)
  } catch {
    next(new HttpError(401, "Invalid or expired token"))
  }
}

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) throw new HttpError(403, "Insufficient permissions")
    next()
  }
