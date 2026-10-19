import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { env } from "../../config/env.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validateBody } from "../../middleware/validate.js";
import { emailService } from "../../services/email.service.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { createSecureToken, hashSecureToken } from "../../utils/secureToken.js";
import { HttpError } from "../../utils/httpError.js";
import { authService } from "../auth/auth.service.js";
export const fundingPartnerRoutes = Router();
fundingPartnerRoutes.use(requireAuth, requireRole("admin"));
const include = { user: true, shares: { where: { revokedAt: null } } };
const dto = (partner) => ({
    id: partner.id,
    name: partner.organisationName,
    type: partner.organisationType,
    email: partner.user.email,
    contactName: partner.user.name,
    phone: partner.user.phone,
    website: partner.website,
    address: partner.address,
    province: partner.province,
    municipality: partner.municipality,
    programmes: partner.programmes,
    description: partner.description,
    verificationNotes: partner.verificationNotes,
    status: partner.user.status,
    activeShares: partner.shares.length,
    createdAt: partner.createdAt.toISOString(),
});
const createSchema = z.object({
    organisationName: z.string().trim().min(2).max(160),
    organisationType: z.string().trim().min(2).max(100),
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
    phone: z.string().trim().min(7).max(30),
    website: z.union([z.string().url().max(300), z.literal("")]).optional(),
    address: z.string().trim().min(4).max(300),
    province: z.string().trim().min(2).max(80),
    municipality: z.string().trim().max(100).optional(),
    programmes: z.string().trim().max(2000).optional(),
    description: z.string().trim().max(2000).optional(),
    verificationNotes: z.string().trim().max(2000).optional(),
}).strict();
const updateSchema = createSchema.omit({ firstName: true, lastName: true, email: true, phone: true }).partial().strict();
fundingPartnerRoutes.get("/", asyncHandler(async (_req, res) => {
    const partners = await prisma.fundingPartner.findMany({
        include,
        orderBy: { organisationName: "asc" },
    });
    res.json({ data: partners.map(dto) });
}));
fundingPartnerRoutes.post("/", rateLimit({ windowMs: 60_000, max: 10 }), validateBody(createSchema), asyncHandler(async (req, res) => {
    try {
        emailService.assertConfigured();
    }
    catch {
        throw new HttpError(503, "Email delivery is temporarily unavailable. Please try again later.");
    }
    if (await prisma.user.findUnique({ where: { email: req.body.email } })) {
        throw new HttpError(409, "An account already exists for that email address");
    }
    if (await prisma.fundingPartner.findUnique({ where: { organisationName: req.body.organisationName } })) {
        throw new HttpError(409, "A funding partner with that organisation name already exists");
    }
    const token = createSecureToken();
    const expiresAt = new Date(Date.now() + env.INVITATION_TOKEN_TTL_MINUTES * 60_000);
    const partner = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
            data: {
                email: req.body.email,
                name: `${req.body.firstName} ${req.body.lastName}`,
                phone: req.body.phone,
                role: "FUNDING_PARTNER",
                status: "PENDING_ACTIVATION",
            },
        });
        const profile = await tx.fundingPartner.create({
            data: {
                userId: user.id,
                organisationName: req.body.organisationName,
                organisationType: req.body.organisationType,
                website: req.body.website || null,
                address: req.body.address,
                province: req.body.province,
                municipality: req.body.municipality || null,
                programmes: req.body.programmes || null,
                description: req.body.description || null,
                verificationNotes: req.body.verificationNotes || null,
                createdById: req.auth.userId,
            },
        });
        const invitation = await tx.accountInvitation.create({
            data: {
                email: user.email,
                role: "FUNDING_PARTNER",
                userId: user.id,
                createdById: req.auth.userId,
                tokenHash: hashSecureToken(token),
                expiresAt,
            },
        });
        await emailService.invitation(tx, {
            email: user.email,
            firstName: req.body.firstName,
            role: "FUNDING_PARTNER",
            organisation: profile.organisationName,
            token,
            userId: user.id,
            invitationId: invitation.id,
        });
        await tx.auditLog.create({
            data: { actorId: req.auth.userId, action: "funding_partner_invited", target: profile.id },
        });
        return tx.fundingPartner.findUniqueOrThrow({ where: { id: profile.id }, include });
    });
    res.status(202).json({ data: dto(partner), invitationStatus: "PENDING" });
}));
fundingPartnerRoutes.get("/:id", asyncHandler(async (req, res) => {
    const partner = await prisma.fundingPartner.findUnique({ where: { id: req.params.id }, include });
    if (!partner)
        throw new HttpError(404, "Funding partner not found");
    res.json({ data: dto(partner) });
}));
fundingPartnerRoutes.patch("/:id", validateBody(updateSchema), asyncHandler(async (req, res) => {
    const partner = await prisma.fundingPartner.findUnique({ where: { id: req.params.id } });
    if (!partner)
        throw new HttpError(404, "Funding partner not found");
    const updated = await prisma.fundingPartner.update({
        where: { id: partner.id },
        data: {
            ...(req.body.organisationName !== undefined ? { organisationName: req.body.organisationName } : {}),
            ...(req.body.organisationType !== undefined ? { organisationType: req.body.organisationType } : {}),
            ...(req.body.website !== undefined ? { website: req.body.website || null } : {}),
            ...(req.body.address !== undefined ? { address: req.body.address } : {}),
            ...(req.body.province !== undefined ? { province: req.body.province } : {}),
            ...(req.body.municipality !== undefined ? { municipality: req.body.municipality || null } : {}),
            ...(req.body.programmes !== undefined ? { programmes: req.body.programmes || null } : {}),
            ...(req.body.description !== undefined ? { description: req.body.description || null } : {}),
            ...(req.body.verificationNotes !== undefined ? { verificationNotes: req.body.verificationNotes || null } : {}),
        },
        include,
    });
    await prisma.auditLog.create({
        data: { actorId: req.auth.userId, action: "funding_partner_updated", target: partner.id },
    });
    res.json({ data: dto(updated) });
}));
fundingPartnerRoutes.post("/:id/resend-invitation", asyncHandler(async (req, res) => {
    const partner = await prisma.fundingPartner.findUnique({ where: { id: req.params.id } });
    if (!partner)
        throw new HttpError(404, "Funding partner not found");
    const invitation = await prisma.accountInvitation.findFirst({
        where: { userId: partner.userId, role: "FUNDING_PARTNER" },
        orderBy: { createdAt: "desc" },
    });
    if (!invitation)
        throw new HttpError(404, "Invitation not found");
    res.status(202).json({
        data: await authService.resendInvitation(invitation.id, req.auth.userId),
    });
}));
fundingPartnerRoutes.post("/:id/suspend", asyncHandler(async (req, res) => {
    const partner = await prisma.fundingPartner.findUnique({
        where: { id: req.params.id },
        include: { user: true },
    });
    if (!partner)
        throw new HttpError(404, "Funding partner not found");
    if (partner.user.status !== "ACTIVE")
        throw new HttpError(409, "Only active funding partners can be suspended");
    await prisma.$transaction(async (tx) => {
        await tx.user.update({
            where: { id: partner.userId },
            data: { status: "SUSPENDED", sessionVersion: { increment: 1 } },
        });
        await tx.businessShare.updateMany({
            where: { fundingPartnerId: partner.id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        await tx.auditLog.create({
            data: { actorId: req.auth.userId, action: "funding_partner_suspended", target: partner.id },
        });
    });
    res.json({ data: { id: partner.id, status: "SUSPENDED" } });
}));
