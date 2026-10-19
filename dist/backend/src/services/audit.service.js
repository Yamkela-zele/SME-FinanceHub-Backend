import { prisma } from "../config/db.js";
export const auditService = {
    record: (actorId, action, target) => prisma.auditLog.create({ data: { actorId, action, target } }),
};
