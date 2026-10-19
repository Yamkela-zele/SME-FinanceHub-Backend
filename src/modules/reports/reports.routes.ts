import { Router } from "express"
import { z } from "zod"
import { prisma } from "../../config/db.js"
import { requireAuth, requireRole } from "../../middleware/auth.js"
import { validateBody } from "../../middleware/validate.js"
import { auditService } from "../../services/audit.service.js"
import { asyncHandler } from "../../utils/asyncHandler.js"
import { businessIdFor } from "../../utils/ownerBusiness.js"
import { businessIdsForUser } from "../../utils/businessAccess.js"

export const reportsRoutes = Router()
reportsRoutes.use(requireAuth)

type R = Awaited<ReturnType<typeof prisma.report.findMany<{ include: { business: true } }>>>[number]
const dto = (r: R) => ({
  id: r.id,
  name: r.name,
  period: r.period,
  format: r.format,
  generated: r.createdAt.toISOString().slice(0, 10),
  businessName: r.business.name,
})

reportsRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const ids = await businessIdsForUser(req.auth!.userId, req.auth!.role)
    const where = req.auth!.role === "owner"
      ? { businessId: await businessIdFor(req.auth!.userId) }
      : ids ? { businessId: { in: ids } } : {}
    const rows = await prisma.report.findMany({ where, include: { business: true }, orderBy: { createdAt: "desc" }, take: 100 })
    if (req.auth!.role === "funder") {
      await Promise.all(rows.map((row) =>
        auditService.record(req.auth!.userId, "Viewed shared business report", `${row.name} · ${row.business.name}`),
      ))
    }
    res.json({ data: rows.map(dto) })
  }),
)

const schema = z.object({ name: z.string().trim().min(2).max(80), period: z.string().trim().min(2).max(40) })

reportsRoutes.post(
  "/",
  requireRole("owner"),
  validateBody(schema),
  asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth!.userId)
    const r = await prisma.report.create({ data: { businessId, ...req.body }, include: { business: true } })
    await auditService.record(req.auth!.userId, "Generated report", `${r.name} · ${r.period}`)
    res.status(201).json({ data: dto(r) })
  }),
)
