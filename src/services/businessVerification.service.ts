import { prisma } from "../config/db.js"
import { env } from "../config/env.js"
import { emailService } from "./email.service.js"

const finalStatuses = ["AUTOMATICALLY_VERIFIED", "MANUALLY_VERIFIED", "VERIFIED_WITH_LIMITATIONS"] as const

export async function expireBusinessVerifications() {
  const now = new Date()
  const due = await prisma.businessVerification.findMany({
    where: { overallStatus: { in: [...finalStatuses] }, expiresAt: { lte: now } },
    include: {
      business: { select: { id: true, name: true } },
      submittedBy: { select: { id: true, name: true, email: true } },
    },
    take: 100,
  })

  for (const verification of due) {
    await prisma.$transaction(async (tx) => {
      const changed = await tx.businessVerification.updateMany({
        where: {
          id: verification.id,
          overallStatus: verification.overallStatus,
          expiresAt: { lte: now },
        },
        data: { overallStatus: "EXPIRED" },
      })
      if (!changed.count) return

      await tx.business.update({
        where: { id: verification.businessId },
        data: { verificationStatus: "PENDING", verifiedAt: null },
      })
      await tx.businessShare.updateMany({
        where: { businessId: verification.businessId, revokedAt: null },
        data: { revokedAt: now },
      })
      await tx.businessVerificationEvent.create({
        data: {
          verificationId: verification.id,
          action: "VERIFICATION_EXPIRED",
          fromStatus: verification.overallStatus,
          toStatus: "EXPIRED",
          reason: "The configured re-verification period elapsed.",
        },
      })
      const title = "Business verification expired"
      const message = `The verification period for ${verification.business.name} has elapsed. Submit an updated request and supporting evidence to restore verification-dependent access.`
      await tx.notification.create({
        data: {
          userId: verification.submittedByUserId,
          title,
          message,
          link: "/app/settings/business-verification",
          urgent: true,
        },
      })
      await tx.auditLog.create({
        data: { action: "business_verification_expired", target: verification.providerReference },
      })
      if (env.EMAIL_OUTBOX_ENCRYPTION_KEY) {
        await emailService.notice(tx, {
          email: verification.submittedBy.email,
          name: verification.submittedBy.name,
          title,
          message,
          userId: verification.submittedBy.id,
        })
      } else {
        console.error(`Business verification expiration email was not queued for ${verification.providerReference}: email outbox encryption is not configured`)
      }
    })
  }
}
