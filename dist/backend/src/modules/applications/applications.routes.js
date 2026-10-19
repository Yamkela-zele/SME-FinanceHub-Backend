import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { auditService } from "../../services/audit.service.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { rand, toCents } from "../../utils/format.js";
import { businessIdFor } from "../../utils/ownerBusiness.js";
import { assertBusinessAccess, assertBusinessVerificationComplete, businessIdsForUser } from "../../utils/businessAccess.js";
export const applicationsRoutes = Router();
applicationsRoutes.use(requireAuth);
const include = { business: { include: { transactions: true } } };
const dto = (a) => {
    const months = new Set(a.business.transactions.map((t) => t.date.toISOString().slice(0, 7)));
    const income = a.business.transactions.filter((t) => t.type === "INCOME").reduce((s, t) => s + t.amountCents, 0);
    return {
        id: a.id,
        ref: `APP-${a.id.slice(-4).toUpperCase()}`,
        business: a.business.name,
        sector: a.business.sector,
        purpose: a.purpose,
        amount: rand(a.amountCents),
        repaid: rand(a.repaidCents),
        score: a.business.readinessScore,
        avgIncome: months.size ? Math.round(rand(income) / months.size) : 0,
        months: months.size,
        status: a.status,
        createdAt: a.createdAt.toISOString().slice(0, 10),
    };
};
applicationsRoutes.get("/", requireRole("owner", "funder"), asyncHandler(async (req, res) => {
    const where = req.auth.role === "owner"
        ? { businessId: await businessIdFor(req.auth.userId) }
        : { businessId: { in: await businessIdsForUser(req.auth.userId, req.auth.role) ?? [] } };
    const rows = await prisma.fundingApplication.findMany({ where, include, orderBy: { createdAt: "desc" } });
    if (req.auth.role === "funder") {
        await Promise.all(rows.map((row) => auditService.record(req.auth.userId, "Viewed shared funding application", `${row.id} · ${row.business.name}`)));
    }
    res.json({ data: rows.map(dto) });
}));
const createSchema = z.object({ amount: z.number().positive().max(100_000_000), purpose: z.string().trim().min(3).max(120) });
applicationsRoutes.post("/", requireRole("owner"), validateBody(createSchema), asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth.userId);
    await assertBusinessVerificationComplete(businessId);
    const a = await prisma.fundingApplication.create({
        data: { businessId, amountCents: toCents(req.body.amount), purpose: req.body.purpose },
        include,
    });
    await auditService.record(req.auth.userId, "Submitted funding application", a.business.name);
    res.status(201).json({ data: dto(a) });
}));
applicationsRoutes.get("/portfolio", requireRole("funder"), asyncHandler(async (req, res) => {
    const businessIds = await businessIdsForUser(req.auth.userId, req.auth.role);
    const rows = await prisma.fundingApplication.findMany({
        where: { status: "APPROVED", businessId: { in: businessIds ?? [] } },
        include,
    });
    await Promise.all(rows.map((row) => auditService.record(req.auth.userId, "Viewed shared funding application", `${row.id} · ${row.business.name}`)));
    res.json({ data: rows.map(dto) });
}));
applicationsRoutes.get("/summary", requireRole("funder"), asyncHandler(async (req, res) => {
    const businessIds = await businessIdsForUser(req.auth.userId, req.auth.role);
    const rows = await prisma.fundingApplication.findMany({
        where: { businessId: { in: businessIds ?? [] } },
        include,
    });
    const by = (s) => rows.filter((r) => r.status === s);
    const decided = by("APPROVED").length + by("DECLINED").length;
    const open = rows.filter((r) => ["RECEIVED", "ASSESSING", "INFO_REQUESTED"].includes(r.status));
    res.json({
        newCount: by("RECEIVED").length,
        pipelineValue: open.reduce((s, r) => s + rand(r.amountCents), 0),
        pipelineCount: open.length,
        approvalRate: decided ? Math.round((by("APPROVED").length / decided) * 100) : null,
        avgReadiness: open.length ? Math.round(open.reduce((s, r) => s + r.business.readinessScore, 0) / open.length) : 0,
        stages: [
            ["Received", "RECEIVED"],
            ["Assessing", "ASSESSING"],
            ["Info requested", "INFO_REQUESTED"],
            ["Approved", "APPROVED"],
            ["Declined", "DECLINED"],
        ].map(([stage, s]) => ({ stage, count: by(s).length })),
        latest: rows.slice(0, 3).map(dto),
    });
}));
const decisionSchema = z.object({ status: z.enum(["APPROVED", "DECLINED", "INFO_REQUESTED", "ASSESSING", "RECEIVED"]) });
applicationsRoutes.patch("/:id/decision", requireRole("funder"), validateBody(decisionSchema), asyncHandler(async (req, res) => {
    const existing = await prisma.fundingApplication.findUnique({ where: { id: req.params.id } });
    if (!existing)
        throw new HttpError(404, "Application not found");
    await assertBusinessAccess(req.auth.userId, req.auth.role, existing.businessId);
    const a = await prisma.fundingApplication.update({ where: { id: existing.id }, data: { status: req.body.status }, include });
    await auditService.record(req.auth.userId, `Application ${req.body.status.toLowerCase().replace("_", " ")}`, `${dto(a).ref} · ${a.business.name}`);
    res.json({ data: dto(a) });
}));
