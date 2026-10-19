import { prisma } from "../config/db.js"

export const auditService = {
  record: (actorId: string | null, action: string, target?: string) =>
    prisma.auditLog.create({ data: { actorId, action, target } }),
}
