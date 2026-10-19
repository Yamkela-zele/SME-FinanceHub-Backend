import { prisma } from "../config/db.js"
import { HttpError } from "./httpError.js"

export async function businessIdFor(userId: string) {
  const membership = await prisma.businessMembership.findFirst({
    where: {
      userId,
      role: "BUSINESS_OWNER",
      revokedAt: null,
      user: { status: "ACTIVE" },
    },
    select: { businessId: true },
  })
  if (!membership) throw new HttpError(404, "No active business workspace is linked to this account")
  return membership.businessId
}
