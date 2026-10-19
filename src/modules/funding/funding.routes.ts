import { Router } from "express"
import { z } from "zod"
import { prisma } from "../../config/db.js"
import { requireAuth, requireRole } from "../../middleware/auth.js"
import { asyncHandler } from "../../utils/asyncHandler.js"
import { HttpError } from "../../utils/httpError.js"
import { businessIdFor } from "../../utils/ownerBusiness.js"
import { validateBody } from "../../middleware/validate.js"
import { auditService } from "../../services/audit.service.js"
import { assertBusinessVerificationComplete, businessIdsForUser } from "../../utils/businessAccess.js"

export const fundingRoutes = Router()
const ownerFundingRoutes = Router()
ownerFundingRoutes.use(requireAuth, requireRole("owner"))

async function snapshot(businessId: string) {
  const items = await prisma.readinessItem.findMany({ where: { businessId }, orderBy: { sort: "asc" } })
  const score = items.length ? Math.round((items.filter((i) => i.complete).length / items.length) * 100) : 0
  return { score, items: items.map((i) => ({ id: i.id, label: i.label, complete: i.complete })) }
}

ownerFundingRoutes.get(
  "/readiness",
  asyncHandler(async (req, res) => res.json(await snapshot(await businessIdFor(req.auth!.userId)))),
)

ownerFundingRoutes.get(
  "/partners",
  asyncHandler(async (_req, res) => {
    const partners = await prisma.fundingPartner.findMany({
      where: { user: { status: "ACTIVE" } },
      select: { id: true, organisationName: true, organisationType: true },
      orderBy: { organisationName: "asc" },
    })
    res.json({ data: partners })
  }),
)

ownerFundingRoutes.get(
  "/shares",
  asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth!.userId)
    const shares = await prisma.businessShare.findMany({
      where: { businessId },
      include: { fundingPartner: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
    })
    res.json({
      data: shares.map((share) => ({
        id: share.id,
        partner: share.fundingPartner.organisationName,
        email: share.fundingPartner.user.email,
        createdAt: share.createdAt.toISOString(),
        expiresAt: share.expiresAt?.toISOString() ?? null,
        revoked: !!share.revokedAt,
      })),
    })
  }),
)

ownerFundingRoutes.post(
  "/shares",
  validateBody(z.object({
    fundingPartnerId: z.string().min(1),
    expiresAt: z.string().datetime().optional(),
  }).strict()),
  asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth!.userId)
    await assertBusinessVerificationComplete(businessId)
    const partner = await prisma.fundingPartner.findUnique({
      where: { id: req.body.fundingPartnerId },
      include: { user: true },
    })
    if (!partner || partner.user.status !== "ACTIVE") throw new HttpError(404, "Active funding partner not found")
    const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null
    if (expiresAt && expiresAt <= new Date()) throw new HttpError(400, "Share expiry must be in the future")
    const existing = await prisma.businessShare.findFirst({
      where: {
        businessId,
        fundingPartnerId: partner.id,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    })
    if (existing) throw new HttpError(409, "This funding partner already has active access")
    const share = await prisma.$transaction(async (tx) => {
      const created = await tx.businessShare.create({
        data: {
          businessId,
          fundingPartnerId: partner.id,
          authorisedById: req.auth!.userId,
          expiresAt,
        },
      })
      await tx.notification.create({
        data: {
          userId: partner.userId,
          title: "A business shared financial information with you",
          message: "A business owner granted access to selected business information.",
          link: "/funding/dashboard",
        },
      })
      await tx.auditLog.create({
        data: {
          actorId: req.auth!.userId,
          action: "Shared business financial information",
          target: partner.organisationName,
        },
      })
      return created
    })
    res.status(201).json({ data: { id: share.id, partner: partner.organisationName, expiresAt: share.expiresAt?.toISOString() ?? null } })
  }),
)

ownerFundingRoutes.delete(
  "/shares/:id",
  asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth!.userId)
    const share = await prisma.businessShare.findFirst({
      where: { id: req.params.id, businessId, revokedAt: null },
      include: { fundingPartner: true },
    })
    if (!share) throw new HttpError(404, "Share not found")
    await prisma.businessShare.updateMany({
      where: {
        businessId,
        fundingPartnerId: share.fundingPartnerId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    })
    await auditService.record(req.auth!.userId, "Revoked business financial information sharing", share.fundingPartner.organisationName)
    res.json({ ok: true })
  }),
)

fundingRoutes.get(
  "/shared-applications",
  requireAuth,
  requireRole("funder"),
  asyncHandler(async (req, res) => {
    const businessIds = await businessIdsForUser(req.auth!.userId, req.auth!.role)
    if (!businessIds?.length) {
      res.json({ data: [] })
      return
    }
    const shares = await prisma.businessShare.findMany({
      where: {
        businessId: { in: businessIds },
        fundingPartner: { userId: req.auth!.userId },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { businessId: true },
    })
    const businessIdsAllowed = shares.map((share) => share.businessId)
    const businesses = await prisma.business.findMany({
      where: { id: { in: businessIdsAllowed } },
      select: { id: true, name: true, industry: true, readinessScore: true },
    })
    await Promise.all(businesses.map((business) =>
      auditService.record(req.auth!.userId, "Viewed shared business financial information", business.name),
    ))
    res.json({ data: businesses })
  }),
)

ownerFundingRoutes.post(
  "/readiness/:id/complete",
  asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth!.userId)
    const item = await prisma.readinessItem.findFirst({ where: { id: req.params.id, businessId } })
    if (!item) throw new HttpError(404, "Item not found")
    await prisma.readinessItem.update({ where: { id: item.id }, data: { complete: true } })
    const snap = await snapshot(businessId)
    await prisma.business.update({ where: { id: businessId }, data: { readinessScore: snap.score } })
    res.json(snap)
  }),
)

fundingRoutes.use(ownerFundingRoutes)
