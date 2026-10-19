import { Router } from "express";
import { prisma } from "../../config/db.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { createTransactionSchema } from "../../validators/transaction.validators.js";
import { auditService } from "../../services/audit.service.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { rand, toCents } from "../../utils/format.js";
import { businessIdFor } from "../../utils/ownerBusiness.js";
import { assertBusinessAccess, businessIdsForUser } from "../../utils/businessAccess.js";
export const transactionsRoutes = Router();
transactionsRoutes.use(requireAuth);
const toDto = (t) => ({
    id: t.id,
    type: t.type,
    description: t.description,
    category: t.category,
    amount: rand(t.amountCents),
    date: t.date.toISOString().slice(0, 10),
    reviewed: t.reviewed,
    issue: t.issue,
    businessName: t.business.name,
});
transactionsRoutes.get("/", requireRole("owner", "accountant"), asyncHandler(async (req, res) => {
    const ids = await businessIdsForUser(req.auth.userId, req.auth.role);
    const where = {
        businessId: req.auth.role === "owner"
            ? await businessIdFor(req.auth.userId)
            : { in: ids ?? [] },
        ...(req.query.reviewed === "false" ? { reviewed: false } : {}),
    };
    const rows = await prisma.transaction.findMany({
        where,
        include: { business: true },
        orderBy: { date: "desc" },
        take: 300,
    });
    res.json({ data: rows.map(toDto) });
}));
transactionsRoutes.post("/", requireRole("owner"), validateBody(createTransactionSchema), asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth.userId);
    const { amount, date, ...rest } = req.body;
    const row = await prisma.transaction.create({
        data: { ...rest, businessId, amountCents: toCents(amount), date: date ? new Date(date) : new Date() },
        include: { business: true },
    });
    res.status(201).json({ data: toDto(row) });
}));
transactionsRoutes.patch("/:id/review", requireRole("accountant"), asyncHandler(async (req, res) => {
    const existing = await prisma.transaction.findUnique({ where: { id: req.params.id }, include: { business: true } });
    if (!existing)
        throw new HttpError(404, "Transaction not found");
    await assertBusinessAccess(req.auth.userId, req.auth.role, existing.businessId);
    const row = await prisma.transaction.update({
        where: { id: existing.id },
        data: { reviewed: true, issue: null },
        include: { business: true },
    });
    await auditService.record(req.auth.userId, "Approved transaction", `${existing.description} · ${existing.business.name}`);
    res.json({ data: toDto(row) });
}));
