import { Router } from "express"
import { z } from "zod"
import { prisma } from "../../config/db.js"
import { requireAuth, requireRole } from "../../middleware/auth.js"
import { validateBody } from "../../middleware/validate.js"
import { auditService } from "../../services/audit.service.js"
import { asyncHandler } from "../../utils/asyncHandler.js"
import { HttpError } from "../../utils/httpError.js"

export const adminRoutes = Router()
adminRoutes.use(requireAuth, requireRole("admin"))

const roleLabel = {
  BUSINESS_OWNER: "Business owner",
  ACCOUNTANT: "Accountant",
  FUNDING_PARTNER: "Funding partner",
  SYSTEM_ADMIN: "Administrator",
} as const

type U = Awaited<ReturnType<typeof prisma.user.findMany<{ include: { business: true } }>>>[number]
const userDto = (u: U) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: roleLabel[u.role],
  organisation: u.business?.name ?? "—",
  status: u.status,
})

adminRoutes.get(
  "/users",
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({ include: { business: true }, orderBy: [{ status: "asc" }, { name: "asc" }] })
    res.json({ data: users.map(userDto) })
  }),
)

adminRoutes.get(
  "/businesses",
  asyncHandler(async (_req, res) => {
    const businesses = await prisma.business.findMany({
      include: {
        owner: { select: { name: true, email: true } },
        verification: { select: { id: true, providerReference: true, overallStatus: true, businessVerificationStatus: true, representativeVerificationStatus: true, createdAt: true } },
      },
      orderBy: [{ verificationStatus: "asc" }, { createdAt: "desc" }],
    })
    res.json({
      data: businesses.map((business) => ({
        id: business.id,
        name: business.name,
        tradingName: business.tradingName,
        businessType: business.businessType,
        industry: business.industry,
        registrationStatus: business.registrationStatus,
        registrationNumber: business.registrationNumber,
        address: business.address,
        province: business.province,
        municipality: business.municipality,
        description: business.description,
        website: business.website,
        sector: business.sector,
        plan: business.plan,
        readiness: business.readinessScore,
        verificationStatus: business.verificationStatus,
        verificationNotes: business.verificationNotes,
        verifiedAt: business.verifiedAt?.toISOString() ?? null,
        verification: business.verification ? {
          id: business.verification.id,
          reference: business.verification.providerReference,
          status: business.verification.overallStatus,
          businessCheck: business.verification.businessVerificationStatus,
          representativeCheck: business.verification.representativeVerificationStatus,
          submittedAt: business.verification.createdAt.toISOString(),
        } : null,
        registered: business.createdAt.toISOString().slice(0, 10),
        owner: business.owner,
      })),
    })
  }),
)

const statusSchema = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) })

adminRoutes.patch(
  "/users/:id/status",
  validateBody(statusSchema),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.auth!.userId) throw new HttpError(400, "You cannot change your own status")
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, "User not found")
    const allowed = existing.status === "ACTIVE" && req.body.status === "SUSPENDED"
      || existing.status === "SUSPENDED" && req.body.status === "ACTIVE"
      || existing.status === "PENDING_ADMIN_REVIEW" && req.body.status === "ACTIVE" && !!existing.emailVerifiedAt
    if (!allowed) throw new HttpError(409, "That account status transition is not allowed")
    const u = await prisma.user.update({
      where: { id: existing.id },
      data: { status: req.body.status, sessionVersion: { increment: 1 } },
      include: { business: true },
    })
    const action = existing.status === "PENDING_ADMIN_REVIEW" ? "Approved owner account" : req.body.status === "SUSPENDED" ? "Suspended account" : "Restored account"
    await auditService.record(req.auth!.userId, action, u.name)
    res.json({ data: userDto(u) })
  }),
)

adminRoutes.get(
  "/audit",
  asyncHandler(async (req, res) => {
    const take = Math.min(Number(req.query.limit) || 50, 200)
    const rows = await prisma.auditLog.findMany({ include: { actor: true }, orderBy: { createdAt: "desc" }, take })
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        at: r.createdAt.toISOString(),
        actor: r.actor?.name ?? "System",
        action: r.action,
        target: r.target ?? "",
      })),
    })
  }),
)

adminRoutes.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    const since = new Date(Date.now() - 7 * 86_400_000)
    const [businesses, users, pending, logins, newBusinesses, events24h] = await Promise.all([
      prisma.business.count(),
      prisma.user.count({ where: { status: "ACTIVE" } }),
      prisma.user.count({ where: { status: { in: ["PENDING_EMAIL_VERIFICATION", "PENDING_ADMIN_REVIEW", "PENDING_ACTIVATION"] } } }),
      prisma.auditLog.findMany({ where: { action: "login", createdAt: { gte: since } } }),
      prisma.business.count({ where: { createdAt: { gte: since } } }),
      prisma.auditLog.count({ where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    ])
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.now() - (6 - i) * 86_400_000)
      const key = d.toISOString().slice(0, 10)
      return {
        d: d.toLocaleString("en-ZA", { weekday: "short" }),
        v: new Set(logins.filter((l) => l.createdAt.toISOString().slice(0, 10) === key).map((l) => l.actorId)).size,
      }
    })
    res.json({ businesses, activeUsers: users, pendingUsers: pending, newBusinesses, events24h, daily: days })
  }),
)
