import { Router } from "express"
import { z } from "zod"
import { prisma } from "../../config/db.js"
import { requireAuth, requireRole } from "../../middleware/auth.js"
import { validateBody } from "../../middleware/validate.js"
import { auditService } from "../../services/audit.service.js"
import { asyncHandler } from "../../utils/asyncHandler.js"
import { HttpError } from "../../utils/httpError.js"
import { monthKey, monthStart, rand } from "../../utils/format.js"
import { assertBusinessAccess, businessIdsForUser } from "../../utils/businessAccess.js"

export const businessesRoutes = Router()
businessesRoutes.use(requireAuth, requireRole("accountant", "admin"))

async function list(businessIds: string[] | null) {
  const businesses = await prisma.business.findMany({
    where: businessIds ? { id: { in: businessIds } } : {},
    include: { transactions: true },
    orderBy: { name: "asc" },
  })
  const signoffs = await prisma.auditLog.findMany({ where: { action: "Signed off report" } })
  const signed = new Set(signoffs.map((s) => s.target))
  return businesses.map((b) => {
    const latest = b.transactions.reduce<Date | null>((m, t) => (!m || t.date > m ? t.date : m), null)
    const key = latest ? monthKey(monthStart(latest)) : null
    const monthIncome = b.transactions
      .filter((t) => t.type === "INCOME" && key && monthKey(t.date) === key)
      .reduce((s, t) => s + t.amountCents, 0)
    return {
      id: b.id,
      name: b.name,
      sector: b.sector,
      plan: b.plan,
      verificationStatus: b.verificationStatus,
      readiness: b.readinessScore,
      registered: b.createdAt.toISOString().slice(0, 10),
      monthIncome: rand(monthIncome),
      toReview: b.transactions.filter((t) => !t.reviewed).length,
      signedOff: signed.has(b.name),
    }
  })
}

businessesRoutes.get("/", asyncHandler(async (req, res) => {
  const ids = await businessIdsForUser(req.auth!.userId, req.auth!.role)
  res.json({ data: await list(ids) })
}))

businessesRoutes.get(
  "/summary",
  requireRole("accountant"),
  asyncHandler(async (req, res) => {
    const businessIds = await businessIdsForUser(req.auth!.userId, req.auth!.role) ?? []
    const data = await list(businessIds)
    const toReview = await prisma.transaction.findMany({
      where: { reviewed: false, businessId: { in: businessIds } },
      include: { business: true },
      orderBy: { date: "asc" },
      take: 4,
    })
    res.json({
      clients: data.length,
      toReview: data.reduce((s, b) => s + b.toReview, 0),
      avgReadiness: data.length ? Math.round(data.reduce((s, b) => s + b.readiness, 0) / data.length) : 0,
      pendingSignoff: data.filter((b) => !b.signedOff && b.toReview === 0).length,
      signoffCandidates: data.filter((b) => b.toReview === 0 || b.signedOff).map((b) => ({ id: b.id, name: b.name, signedOff: b.signedOff })),
      attention: toReview.map((t) => ({ id: t.id, description: t.description, client: t.business.name, amount: rand(t.amountCents), issue: t.issue ?? "Needs review" })),
    })
  }),
)

businessesRoutes.post(
  "/:id/signoff",
  requireRole("accountant"),
  asyncHandler(async (req, res) => {
    const b = await prisma.business.findUnique({ where: { id: req.params.id } })
    if (!b) throw new HttpError(404, "Business not found")
    await assertBusinessAccess(req.auth!.userId, req.auth!.role, b.id)
    await auditService.record(req.auth!.userId, "Signed off report", b.name)
    res.json({ ok: true })
  }),
)

const notifySchema = z.object({ kind: z.enum(["records", "reminder"]) })

businessesRoutes.post(
  "/:id/notify",
  validateBody(notifySchema),
  asyncHandler(async (req, res) => {
    const b = await prisma.business.findUnique({ where: { id: req.params.id } })
    if (!b) throw new HttpError(404, "Business not found")
    await assertBusinessAccess(req.auth!.userId, req.auth!.role, b.id)
    await auditService.record(req.auth!.userId, req.body.kind === "records" ? "Requested records" : "Sent reminder", b.name)
    res.json({ ok: true })
  }),
)
