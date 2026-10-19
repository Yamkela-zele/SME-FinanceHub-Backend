import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { rand } from "../../utils/format.js";
import { businessIdFor } from "../../utils/ownerBusiness.js";
export const customersRoutes = Router();
customersRoutes.use(requireAuth, requireRole("owner"));
customersRoutes.get("/", asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth.userId);
    const customers = await prisma.customer.findMany({
        where: { businessId },
        include: { invoices: { orderBy: { dueDate: "desc" } } },
        orderBy: { name: "asc" },
    });
    res.json({
        data: customers.map((c) => {
            const outstanding = c.invoices
                .filter((i) => i.status !== "PAID" && i.status !== "DRAFT")
                .reduce((sum, i) => sum + i.totalCents - i.paidCents, 0);
            return {
                id: c.id,
                name: c.name,
                email: c.email,
                lastInvoice: c.invoices[0]?.number ?? null,
                outstanding: rand(outstanding),
                overdue: c.invoices.some((i) => i.status === "OVERDUE"),
            };
        }),
    });
}));
const schema = z.object({ name: z.string().trim().min(2).max(80), email: z.string().email().optional().or(z.literal("")) });
customersRoutes.post("/", validateBody(schema), asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth.userId);
    const c = await prisma.customer.create({
        data: { businessId, name: req.body.name, email: req.body.email || null },
    });
    res.status(201).json({ data: { id: c.id, name: c.name, email: c.email, lastInvoice: null, outstanding: 0, overdue: false } });
}));
