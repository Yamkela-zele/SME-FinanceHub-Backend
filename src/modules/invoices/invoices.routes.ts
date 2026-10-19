import { Router } from "express"
import { z } from "zod"
import { prisma } from "../../config/db.js"
import { requireAuth, requireRole } from "../../middleware/auth.js"
import { validateBody } from "../../middleware/validate.js"
import { asyncHandler } from "../../utils/asyncHandler.js"
import { HttpError } from "../../utils/httpError.js"
import { rand, toCents } from "../../utils/format.js"
import { businessIdFor } from "../../utils/ownerBusiness.js"

export const invoicesRoutes = Router()
invoicesRoutes.use(requireAuth, requireRole("owner"))

type Inv = Awaited<ReturnType<typeof prisma.invoice.findMany<{ include: { customer: true } }>>>[number]
const dto = (i: Inv) => ({
  id: i.id,
  number: i.number,
  customer: i.customer.name,
  status: i.status,
  total: rand(i.totalCents),
  balance: rand(i.totalCents - i.paidCents),
  dueDate: i.dueDate.toISOString().slice(0, 10),
})

invoicesRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth!.userId)
    const rows = await prisma.invoice.findMany({
      where: { businessId },
      include: { customer: true },
      orderBy: { dueDate: "desc" },
    })
    res.json({ data: rows.map(dto) })
  }),
)

const createSchema = z.object({
  customer: z.string().trim().min(2).max(80),
  amount: z.number().positive().max(100_000_000),
  dueDate: z.string().date(),
})

invoicesRoutes.post(
  "/",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth!.userId)
    const { customer, amount, dueDate } = req.body
    const created = await prisma.$transaction(async (tx) => {
      let c = await tx.customer.findFirst({ where: { businessId, name: { equals: customer } } })
      c ??= await tx.customer.create({ data: { businessId, name: customer } })
      const count = await tx.invoice.count({ where: { businessId } })
      return tx.invoice.create({
        data: {
          businessId,
          customerId: c.id,
          number: `INV-${new Date().getUTCFullYear()}-${String(count + 1).padStart(3, "0")}`,
          status: "SENT",
          totalCents: toCents(amount),
          dueDate: new Date(dueDate),
        },
        include: { customer: true },
      })
    })
    res.status(201).json({ data: dto(created) })
  }),
)

invoicesRoutes.patch(
  "/:id/paid",
  asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth!.userId)
    const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, businessId } })
    if (!inv) throw new HttpError(404, "Invoice not found")
    const updated = await prisma.invoice.update({
      where: { id: inv.id },
      data: { status: "PAID", paidCents: inv.totalCents },
      include: { customer: true },
    })
    res.json({ data: dto(updated) })
  }),
)
