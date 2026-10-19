import { createHash, randomBytes } from "node:crypto"

export const createSecureToken = () => randomBytes(32).toString("base64url")
export const hashSecureToken = (token: string) => createHash("sha256").update(token).digest("hex")

export function isStrongPassword(password: string) {
  return password.length >= 12
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password)
}
