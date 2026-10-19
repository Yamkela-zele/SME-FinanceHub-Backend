import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { env } from "../../config/env.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validateBody } from "../../middleware/validate.js";
import { emailService } from "../../services/email.service.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { assertBusinessAccess } from "../../utils/businessAccess.js";
import { createSecureToken, hashSecureToken } from "../../utils/secureToken.js";
import { HttpError } from "../../utils/httpError.js";
import { authService } from "../auth/auth.service.js";
export const accountantRoutes = Router();
const applicationDto = (application) => ({
    id: application.id,
    name: `${application.firstName} ${application.lastName}`,
    firstName: application.firstName,
    lastName: application.lastName,
    email: application.email,
    phone: application.phone,
    jobTitle: application.jobTitle,
    responsibilities: application.responsibilities,
    reason: application.reason,
    status: application.status,
    submittedAt: application.submittedAt.toISOString(),
    reviewedAt: application.reviewedAt?.toISOString() ?? null,
    reviewNotes: application.reviewNotes,
    business: { id: application.business.id, name: application.business.name },
    owner: {
        id: application.submittedBy.id,
        name: application.submittedBy.name,
        email: application.submittedBy.email,
    },
    reviewer: application.reviewedBy ?? null,
    reviews: application.reviews?.map((review) => ({
        action: review.action,
        notes: review.notes,
        reviewer: review.reviewer.name,
        at: review.createdAt.toISOString(),
    })) ?? [],
});
const ownerApplicationInclude = {
    business: true,
    submittedBy: true,
    reviewedBy: { select: { id: true, name: true } },
    reviews: { include: { reviewer: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
};
const ownerApplicationSchema = z.object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
    phone: z.string().trim().min(7).max(30),
    jobTitle: z.string().trim().max(100).optional(),
    responsibilities: z.string().trim().min(3).max(1000),
    reason: z.string().trim().max(1000).optional(),
}).strict();
const reviewNoteSchema = z.object({ reason: z.string().trim().min(5).max(2000) }).strict();
accountantRoutes.get("/businesses/:businessId/accountants", requireAuth, requireRole("owner"), asyncHandler(async (req, res) => {
    await assertBusinessAccess(req.auth.userId, req.auth.role, req.params.businessId);
    const applications = await prisma.accountantApplication.findMany({
        where: { businessId: req.params.businessId, submittedById: req.auth.userId },
        include: ownerApplicationInclude,
        orderBy: { submittedAt: "desc" },
    });
    res.json({ data: applications.map(applicationDto) });
}));
accountantRoutes.post("/businesses/:businessId/accountants", requireAuth, requireRole("owner"), rateLimit({ windowMs: 60 * 60_000, max: 10 }), validateBody(ownerApplicationSchema), asyncHandler(async (req, res) => {
    await assertBusinessAccess(req.auth.userId, req.auth.role, req.params.businessId);
    const email = req.body.email;
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser)
        throw new HttpError(409, "An account already exists for that email address");
    const existingApplication = await prisma.accountantApplication.findFirst({
        where: {
            businessId: req.params.businessId,
            email,
            status: { notIn: ["REJECTED", "WITHDRAWN"] },
        },
    });
    if (existingApplication)
        throw new HttpError(409, "An application for that email is already active");
    const application = await prisma.$transaction(async (tx) => {
        const created = await tx.accountantApplication.create({
            data: {
                businessId: req.params.businessId,
                submittedById: req.auth.userId,
                firstName: req.body.firstName,
                lastName: req.body.lastName,
                email,
                phone: req.body.phone,
                jobTitle: req.body.jobTitle || null,
                responsibilities: req.body.responsibilities,
                reason: req.body.reason || null,
            },
            include: ownerApplicationInclude,
        });
        await tx.accountantReview.create({
            data: { applicationId: created.id, reviewerId: req.auth.userId, action: "SUBMITTED" },
        });
        await tx.auditLog.create({
            data: {
                actorId: req.auth.userId,
                action: "accountant_application_submitted",
                target: created.id,
            },
        });
        return created;
    });
    res.status(201).json({ data: applicationDto(application) });
}));
accountantRoutes.get("/accountant-applications/:id", requireAuth, asyncHandler(async (req, res) => {
    const application = await prisma.accountantApplication.findUnique({
        where: { id: req.params.id },
        include: ownerApplicationInclude,
    });
    if (!application)
        throw new HttpError(404, "Application not found");
    if (req.auth.role !== "admin" && application.submittedById !== req.auth.userId) {
        throw new HttpError(403, "You do not have access to this application");
    }
    res.json({ data: applicationDto(application) });
}));
accountantRoutes.patch("/accountant-applications/:id", requireAuth, requireRole("owner"), validateBody(ownerApplicationSchema), asyncHandler(async (req, res) => {
    const application = await prisma.accountantApplication.findUnique({
        where: { id: req.params.id },
    });
    if (!application || application.submittedById !== req.auth.userId) {
        throw new HttpError(404, "Application not found");
    }
    if (!["CHANGES_REQUIRED", "PENDING_ADMIN_APPROVAL"].includes(application.status)) {
        throw new HttpError(409, "This application can no longer be edited");
    }
    const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.accountantApplication.updateMany({
            where: { id: application.id, submittedById: req.auth.userId, status: { in: ["CHANGES_REQUIRED", "PENDING_ADMIN_APPROVAL"] } },
            data: {
                ...req.body,
                email: req.body.email,
                jobTitle: req.body.jobTitle || null,
                reason: req.body.reason || null,
                status: "PENDING_ADMIN_APPROVAL",
                reviewNotes: null,
            },
        });
        if (!changed.count)
            throw new HttpError(409, "This application can no longer be edited");
        await tx.accountantReview.create({
            data: { applicationId: application.id, reviewerId: req.auth.userId, action: "RESUBMITTED" },
        });
        await tx.auditLog.create({
            data: { actorId: req.auth.userId, action: "accountant_application_resubmitted", target: application.id },
        });
        return tx.accountantApplication.findUniqueOrThrow({
            where: { id: application.id },
            include: ownerApplicationInclude,
        });
    });
    res.json({ data: applicationDto(updated) });
}));
accountantRoutes.post("/accountant-applications/:id/withdraw", requireAuth, requireRole("owner"), asyncHandler(async (req, res) => {
    const application = await prisma.accountantApplication.findUnique({ where: { id: req.params.id } });
    if (!application || application.submittedById !== req.auth.userId) {
        throw new HttpError(404, "Application not found");
    }
    if (["APPROVED", "REJECTED", "WITHDRAWN"].includes(application.status)) {
        throw new HttpError(409, "This application can no longer be withdrawn");
    }
    const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.accountantApplication.updateMany({
            where: {
                id: application.id,
                submittedById: req.auth.userId,
                status: { in: ["PENDING_ADMIN_APPROVAL", "UNDER_REVIEW", "CHANGES_REQUIRED"] },
            },
            data: { status: "WITHDRAWN" },
        });
        if (!changed.count)
            throw new HttpError(409, "This application can no longer be withdrawn");
        await tx.accountantReview.create({
            data: { applicationId: application.id, reviewerId: req.auth.userId, action: "WITHDRAWN" },
        });
        await tx.auditLog.create({
            data: { actorId: req.auth.userId, action: "accountant_application_withdrawn", target: application.id },
        });
        return tx.accountantApplication.findUniqueOrThrow({
            where: { id: application.id },
            include: ownerApplicationInclude,
        });
    });
    res.json({ data: applicationDto(updated) });
}));
const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("admin"));
adminRouter.get("/admin/accountant-applications/summary", asyncHandler(async (_req, res) => {
    const [pending, review, changes, approved, rejected, awaiting] = await Promise.all([
        prisma.accountantApplication.count({ where: { status: "PENDING_ADMIN_APPROVAL" } }),
        prisma.accountantApplication.count({ where: { status: "UNDER_REVIEW" } }),
        prisma.accountantApplication.count({ where: { status: "CHANGES_REQUIRED" } }),
        prisma.accountantApplication.count({ where: { status: "APPROVED" } }),
        prisma.accountantApplication.count({ where: { status: "REJECTED" } }),
        prisma.accountInvitation.count({ where: { role: "ACCOUNTANT", status: { in: ["PENDING", "SENT"] } } }),
    ]);
    res.json({ pending, review, changes, approved, rejected, awaiting });
}));
adminRouter.get("/admin/accountant-applications", asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
    const status = typeof req.query.status === "string" && req.query.status
        ? z.enum(["PENDING_ADMIN_APPROVAL", "UNDER_REVIEW", "CHANGES_REQUIRED", "APPROVED", "REJECTED", "WITHDRAWN"]).parse(req.query.status)
        : undefined;
    const query = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const where = {
        ...(status ? { status } : {}),
        ...(query ? {
            OR: [
                { email: { contains: query } },
                { firstName: { contains: query } },
                { lastName: { contains: query } },
                { business: { name: { contains: query } } },
                { submittedBy: { name: { contains: query } } },
            ],
        } : {}),
    };
    const [total, applications] = await Promise.all([
        prisma.accountantApplication.count({ where }),
        prisma.accountantApplication.findMany({
            where,
            include: ownerApplicationInclude,
            orderBy: { submittedAt: "desc" },
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
    ]);
    res.json({
        data: applications.map(applicationDto),
        page,
        pageSize,
        total,
    });
}));
adminRouter.get("/admin/accountant-applications/:id", asyncHandler(async (req, res) => {
    const application = await prisma.accountantApplication.findUnique({
        where: { id: req.params.id },
        include: ownerApplicationInclude,
    });
    if (!application)
        throw new HttpError(404, "Application not found");
    res.json({ data: applicationDto(application) });
}));
adminRouter.post("/admin/accountant-applications/:id/approve", rateLimit({ windowMs: 60_000, max: 20 }), asyncHandler(async (req, res) => {
    try {
        emailService.assertConfigured();
    }
    catch {
        throw new HttpError(503, "Email delivery is temporarily unavailable. Please try again later.");
    }
    const application = await prisma.accountantApplication.findUnique({
        where: { id: req.params.id },
        include: { business: true, submittedBy: true },
    });
    if (!application)
        throw new HttpError(404, "Application not found");
    if (application.submittedById === req.auth.userId)
        throw new HttpError(403, "You cannot approve an application you submitted");
    if (!["PENDING_ADMIN_APPROVAL", "UNDER_REVIEW"].includes(application.status)) {
        throw new HttpError(409, "This application is not awaiting approval");
    }
    if (await prisma.user.findUnique({ where: { email: application.email } })) {
        throw new HttpError(409, "An account already exists for the applicant email");
    }
    const token = createSecureToken();
    const expiresAt = new Date(Date.now() + env.INVITATION_TOKEN_TTL_MINUTES * 60_000);
    const result = await prisma.$transaction(async (tx) => {
        const claimed = await tx.accountantApplication.updateMany({
            where: {
                id: application.id,
                submittedById: { not: req.auth.userId },
                status: { in: ["PENDING_ADMIN_APPROVAL", "UNDER_REVIEW"] },
            },
            data: { status: "APPROVED", reviewedById: req.auth.userId, reviewedAt: new Date() },
        });
        if (!claimed.count)
            throw new HttpError(409, "This application is not awaiting approval");
        const user = await tx.user.create({
            data: {
                email: application.email,
                name: `${application.firstName} ${application.lastName}`,
                phone: application.phone,
                role: "ACCOUNTANT",
                status: "PENDING_ACTIVATION",
            },
        });
        const invitation = await tx.accountInvitation.create({
            data: {
                email: user.email,
                role: "ACCOUNTANT",
                userId: user.id,
                businessId: application.businessId,
                accountantApplicationId: application.id,
                createdById: req.auth.userId,
                tokenHash: hashSecureToken(token),
                expiresAt,
            },
        });
        await emailService.invitation(tx, {
            email: user.email,
            firstName: application.firstName,
            role: "ACCOUNTANT",
            organisation: application.business.name,
            token,
            userId: user.id,
            invitationId: invitation.id,
        });
        await tx.accountantReview.create({
            data: { applicationId: application.id, reviewerId: req.auth.userId, action: "APPROVED" },
        });
        await tx.notification.create({
            data: {
                userId: application.submittedById,
                title: "Accountant application approved",
                message: `${application.firstName} ${application.lastName} was approved and will receive an activation invitation.`,
                link: "/app/settings/team",
                urgent: false,
            },
        });
        await emailService.notice(tx, {
            email: application.submittedBy.email,
            name: application.submittedBy.name,
            title: "Accountant application approved",
            message: `${application.firstName} ${application.lastName} was approved and will receive an activation invitation.`,
            userId: application.submittedById,
        });
        await tx.auditLog.create({
            data: { actorId: req.auth.userId, action: "accountant_application_approved", target: application.id },
        });
        return { invitationId: invitation.id };
    });
    res.status(202).json({ data: { applicationId: application.id, invitationId: result.invitationId, status: "APPROVED" } });
}));
adminRouter.post("/admin/accountant-applications/:id/request-changes", validateBody(reviewNoteSchema), asyncHandler(async (req, res) => {
    try {
        emailService.assertConfigured();
    }
    catch {
        throw new HttpError(503, "Email delivery is temporarily unavailable. Please try again later.");
    }
    const application = await prisma.accountantApplication.findUnique({
        where: { id: req.params.id },
        include: { submittedBy: true },
    });
    if (!application)
        throw new HttpError(404, "Application not found");
    if (!["PENDING_ADMIN_APPROVAL", "UNDER_REVIEW", "CHANGES_REQUIRED"].includes(application.status)) {
        throw new HttpError(409, "Changes cannot be requested for this application");
    }
    await prisma.$transaction(async (tx) => {
        const changed = await tx.accountantApplication.updateMany({
            where: {
                id: application.id,
                status: { in: ["PENDING_ADMIN_APPROVAL", "UNDER_REVIEW", "CHANGES_REQUIRED"] },
            },
            data: {
                status: "CHANGES_REQUIRED",
                reviewedById: req.auth.userId,
                reviewedAt: new Date(),
                reviewNotes: req.body.reason,
            },
        });
        if (!changed.count)
            throw new HttpError(409, "Changes cannot be requested for this application");
        await tx.accountantReview.create({
            data: { applicationId: application.id, reviewerId: req.auth.userId, action: "CHANGES_REQUIRED", notes: req.body.reason },
        });
        await tx.notification.create({
            data: {
                userId: application.submittedById,
                title: "Accountant application needs changes",
                message: req.body.reason,
                link: "/app/settings/team",
                urgent: true,
            },
        });
        await emailService.notice(tx, {
            email: application.submittedBy.email,
            name: application.submittedBy.name,
            title: "Accountant application needs changes",
            message: req.body.reason,
            userId: application.submittedById,
        });
        await tx.auditLog.create({
            data: { actorId: req.auth.userId, action: "accountant_application_changes_requested", target: application.id },
        });
    });
    res.json({ data: { id: application.id, status: "CHANGES_REQUIRED" } });
}));
adminRouter.post("/admin/accountant-applications/:id/reject", validateBody(reviewNoteSchema), asyncHandler(async (req, res) => {
    try {
        emailService.assertConfigured();
    }
    catch {
        throw new HttpError(503, "Email delivery is temporarily unavailable. Please try again later.");
    }
    const application = await prisma.accountantApplication.findUnique({
        where: { id: req.params.id },
        include: { submittedBy: true },
    });
    if (!application)
        throw new HttpError(404, "Application not found");
    if (["APPROVED", "REJECTED", "WITHDRAWN"].includes(application.status)) {
        throw new HttpError(409, "This application can no longer be rejected");
    }
    await prisma.$transaction(async (tx) => {
        const changed = await tx.accountantApplication.updateMany({
            where: {
                id: application.id,
                status: { in: ["PENDING_ADMIN_APPROVAL", "UNDER_REVIEW", "CHANGES_REQUIRED"] },
            },
            data: {
                status: "REJECTED",
                reviewedById: req.auth.userId,
                reviewedAt: new Date(),
                reviewNotes: req.body.reason,
            },
        });
        if (!changed.count)
            throw new HttpError(409, "This application can no longer be rejected");
        await tx.accountantReview.create({
            data: { applicationId: application.id, reviewerId: req.auth.userId, action: "REJECTED", notes: req.body.reason },
        });
        await tx.notification.create({
            data: {
                userId: application.submittedById,
                title: "Accountant application rejected",
                message: req.body.reason,
                link: "/app/settings/team",
                urgent: true,
            },
        });
        await emailService.notice(tx, {
            email: application.submittedBy.email,
            name: application.submittedBy.name,
            title: "Accountant application rejected",
            message: req.body.reason,
            userId: application.submittedById,
        });
        await tx.auditLog.create({
            data: { actorId: req.auth.userId, action: "accountant_application_rejected", target: application.id },
        });
    });
    res.json({ data: { id: application.id, status: "REJECTED" } });
}));
adminRouter.post("/admin/accountant-applications/:id/review", asyncHandler(async (req, res) => {
    const application = await prisma.accountantApplication.findUnique({ where: { id: req.params.id } });
    if (!application)
        throw new HttpError(404, "Application not found");
    if (!["PENDING_ADMIN_APPROVAL", "CHANGES_REQUIRED"].includes(application.status)) {
        throw new HttpError(409, "This application cannot be returned to review");
    }
    await prisma.$transaction(async (tx) => {
        const changed = await tx.accountantApplication.updateMany({
            where: {
                id: application.id,
                status: { in: ["PENDING_ADMIN_APPROVAL", "CHANGES_REQUIRED"] },
            },
            data: { status: "UNDER_REVIEW", reviewedById: req.auth.userId, reviewedAt: new Date() },
        });
        if (!changed.count)
            throw new HttpError(409, "This application cannot be returned to review");
        await tx.accountantReview.create({
            data: { applicationId: application.id, reviewerId: req.auth.userId, action: "UNDER_REVIEW" },
        });
        await tx.auditLog.create({
            data: { actorId: req.auth.userId, action: "accountant_application_review_started", target: application.id },
        });
    });
    res.json({ data: { id: application.id, status: "UNDER_REVIEW" } });
}));
adminRouter.post("/admin/accountant-applications/:id/resend-invitation", asyncHandler(async (req, res) => res.status(202).json({
    data: await (async () => {
        const application = await prisma.accountantApplication.findUnique({ where: { id: req.params.id } });
        if (!application)
            throw new HttpError(404, "Application not found");
        const invitation = await prisma.accountInvitation.findFirst({
            where: { accountantApplicationId: application.id },
            orderBy: { createdAt: "desc" },
        });
        if (!invitation)
            throw new HttpError(404, "Invitation not found");
        return authService.resendInvitation(invitation.id, req.auth.userId);
    })(),
})));
accountantRoutes.use(adminRouter);
