import jwt from "jsonwebtoken"
import type { Role } from "../../../frontend/shared/types/index.js"
import { env } from "../config/env.js"

export type TokenPayload = { sub: string; role: Role; sessionVersion: number }

export const signToken = (payload: TokenPayload) =>
  jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] })

export const verifyToken = (token: string) => jwt.verify(token, env.JWT_SECRET) as TokenPayload & jwt.JwtPayload
