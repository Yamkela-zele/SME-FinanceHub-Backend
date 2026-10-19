import bcrypt from "bcryptjs";
import { prisma } from "../../config/db.js";
import { env } from "../../config/env.js";
import { auditService } from "../../services/audit.service.js";
import { emailService } from "../../services/email.service.js";
import { HttpError } from "../../utils/httpError.js";
import { createSecureToken, hashSecureToken, isStrongPassword } from "../../utils/secureToken.js";
import { signToken } from "../../utils/jwt.js";
const roleForClient = {
    BUSINESS_OWNER: "owner",
    ACCOUNTANT: "accountant",
    FUNDING_PARTNER: "funder",
    SYSTEM_ADMIN: "admin",
};
const publicUser = (user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: roleForClient[user.role],
    businessId: user.businessId,
    businessName: user.business?.name ?? null,
    businessVerificationStatus: user.business?.verificationStatus ?? null,
});
const genericRegistrationMessage = "If your registration can be accepted, an email with the next steps will be sent to the address provided.";
export const authService = {
    async login(email, password) {
        const normalizedEmail = email.trim().toLowerCase();
        const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
        const ok = user?.passwordHash
            ? await bcrypt.compare(password, user.passwordHash)
            : await bcrypt.compare(password, "$2a$12$C6UzMDM.H6dfI/f/IKcEe.5eW8O0YKyT2i3EfX2JHkNRq3h7g.B3K");
        if (!user || !ok || user.status !== "ACTIVE")
            throw new HttpError(401, "Invalid email or password");
        await auditService.record(user.id, "login");
        const full = await prisma.user.findUnique({ where: { id: user.id }, include: { business: true } });
        if (!full)
            throw new HttpError(401, "Invalid email or password");
        return {
            token: signToken({ sub: user.id, role: roleForClient[user.role], sessionVersion: user.sessionVersion }),
            user: publicUser(full),
        };
    },
    async registerOwner(input) {
        try {
            emailService.assertConfigured();
        }
        catch {
            throw new HttpError(503, "Email verification is temporarily unavailable. Please try again later.");
        }
        const email = input.email.trim().toLowerCase();
        const businessName = input.legalName?.trim() || input.tradingName?.trim();
        if (!businessName)
            throw new HttpError(400, "Enter a legal or trading business name");
        const existingUser = await prisma.user.findUnique({ where: { email } });
        const registrationNumber = input.registrationNumber?.trim().toUpperCase();
        const existingRegistration = registrationNumber
            ? await prisma.business.findUnique({ where: { registrationNumber } })
            : null;
        if (existingUser || existingRegistration)
            return { message: genericRegistrationMessage };
        const verificationToken = createSecureToken();
        const expiresAt = new Date(Date.now() + env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES * 60_000);
        const name = `${input.firstName.trim()} ${input.lastName.trim()}`;
        try {
            await prisma.$transaction(async (tx) => {
                const user = await tx.user.create({
                    data: {
                        email,
                        name,
                        phone: input.phone.trim(),
                        termsAcceptedAt: new Date(),
                        privacyAcknowledgedAt: new Date(),
                        role: "BUSINESS_OWNER",
                        status: "PENDING_EMAIL_VERIFICATION",
                    },
                });
                const business = await tx.business.create({
                    data: {
                        name: businessName,
                        tradingName: input.tradingName?.trim() || null,
                        businessType: input.businessType,
                        industry: input.industry,
                        registrationStatus: input.registrationStatus,
                        registrationNumber: registrationNumber || null,
                        ownerRelationship: input.applicantRelationship,
                        ownerAuthorityDescription: input.authorityDescription.trim(),
                        address: input.address.trim(),
                        province: input.province,
                        municipality: input.municipality.trim(),
                        description: input.description.trim(),
                        website: input.website?.trim() || null,
                        ownerId: user.id,
                        readiness: {
                            create: [
                                "Business registration",
                                "Tax clearance / SARS compliance",
                                "Proof of business address",
                                "Owner identity documents",
                                "Income records",
                                "Invoices up to date",
                                "Financial statements",
                                "Bank statements",
                                "Funding purpose statement",
                            ].map((label, sort) => ({ label, sort })),
                        },
                    },
                });
                await tx.user.update({ where: { id: user.id }, data: { businessId: business.id } });
                await tx.businessMembership.create({
                    data: { userId: user.id, businessId: business.id, role: "BUSINESS_OWNER" },
                });
                await tx.emailVerificationToken.create({
                    data: { userId: user.id, tokenHash: hashSecureToken(verificationToken), expiresAt },
                });
                await emailService.ownerVerification(tx, {
                    email,
                    firstName: input.firstName.trim(),
                    token: verificationToken,
                    userId: user.id,
                });
                await tx.auditLog.create({
                    data: { actorId: user.id, action: "owner_registration_submitted", target: business.id },
                });
            });
        }
        catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
                return { message: genericRegistrationMessage };
            }
            throw error;
        }
        return { message: "Registration received. Your verification email has been queued." };
    },
    async verifyEmail(token) {
        const tokenHash = hashSecureToken(token);
        const setupToken = createSecureToken();
        const verification = await prisma.emailVerificationToken.findUnique({
            where: { tokenHash },
            include: { user: true },
        });
        if (verification && verification.expiresAt <= new Date() && !verification.usedAt) {
            await prisma.emailVerificationToken.updateMany({
                where: { id: verification.id, usedAt: null },
                data: { usedAt: new Date() },
            });
        }
        if (!verification || verification.usedAt || verification.expiresAt <= new Date()) {
            throw new HttpError(400, "This verification link is invalid or expired");
        }
        if (verification.user.status !== "PENDING_EMAIL_VERIFICATION") {
            throw new HttpError(400, "This verification link is invalid or expired");
        }
        const expiresAt = new Date(Date.now() + env.PASSWORD_SETUP_TOKEN_TTL_MINUTES * 60_000);
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.emailVerificationToken.updateMany({
                where: { id: verification.id, usedAt: null, expiresAt: { gt: new Date() } },
                data: { usedAt: new Date() },
            });
            if (!claimed.count)
                throw new HttpError(400, "This verification link is invalid or expired");
            await tx.user.update({
                where: { id: verification.userId },
                data: { emailVerifiedAt: new Date() },
            });
            await tx.passwordSetupToken.create({
                data: { userId: verification.userId, tokenHash: hashSecureToken(setupToken), expiresAt },
            });
            await tx.auditLog.create({
                data: { actorId: verification.userId, action: "owner_email_verified" },
            });
        });
        return { passwordSetupToken: setupToken };
    },
    async createPassword(token, password) {
        if (!isStrongPassword(password)) {
            throw new HttpError(400, "Password must be at least 12 characters and include uppercase, lowercase, number, and symbol characters");
        }
        const tokenHash = hashSecureToken(token);
        const setup = await prisma.passwordSetupToken.findUnique({
            where: { tokenHash },
            include: { user: true },
        });
        if (!setup || setup.usedAt || setup.expiresAt <= new Date() || !setup.user.emailVerifiedAt) {
            throw new HttpError(400, "This password setup link is invalid or expired");
        }
        const passwordHash = await bcrypt.hash(password, 12);
        const status = env.OWNER_REGISTRATION_REQUIRES_REVIEW ? "PENDING_ADMIN_REVIEW" : "ACTIVE";
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.passwordSetupToken.updateMany({
                where: { id: setup.id, usedAt: null, expiresAt: { gt: new Date() } },
                data: { usedAt: new Date() },
            });
            if (!claimed.count)
                throw new HttpError(400, "This password setup link is invalid or expired");
            await tx.user.update({
                where: { id: setup.userId, status: "PENDING_EMAIL_VERIFICATION" },
                data: { passwordHash, passwordChangedAt: new Date(), status, sessionVersion: { increment: 1 } },
            });
            await tx.auditLog.create({
                data: { actorId: setup.userId, action: "owner_password_created" },
            });
            if (status === "PENDING_ADMIN_REVIEW") {
                await tx.notification.create({
                    data: {
                        userId: setup.userId,
                        title: "Business account pending review",
                        message: "Your email is verified. Access will be available after administrator review.",
                        link: "/registration-pending",
                    },
                });
            }
            else {
                await emailService.activationConfirmation(tx, {
                    email: setup.user.email,
                    firstName: setup.user.name.split(/\s+/)[0],
                    userId: setup.userId,
                });
            }
        });
        if (status !== "ACTIVE")
            return { active: false };
        const full = await prisma.user.findUnique({ where: { id: setup.userId }, include: { business: true } });
        if (!full)
            throw new HttpError(404, "Account not found");
        return {
            active: true,
            token: signToken({ sub: full.id, role: roleForClient[full.role], sessionVersion: full.sessionVersion }),
            user: publicUser(full),
        };
    },
    async resendVerification(email) {
        try {
            emailService.assertConfigured();
        }
        catch {
            throw new HttpError(503, "Email verification is temporarily unavailable. Please try again later.");
        }
        const normalizedEmail = email.trim().toLowerCase();
        const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
        if (!user || user.role !== "BUSINESS_OWNER" || user.status !== "PENDING_EMAIL_VERIFICATION") {
            return { message: genericRegistrationMessage };
        }
        const verificationToken = createSecureToken();
        const expiresAt = new Date(Date.now() + env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES * 60_000);
        await prisma.$transaction(async (tx) => {
            await tx.emailVerificationToken.updateMany({
                where: { userId: user.id, usedAt: null },
                data: { usedAt: new Date() },
            });
            await tx.emailVerificationToken.create({
                data: { userId: user.id, tokenHash: hashSecureToken(verificationToken), expiresAt },
            });
            await emailService.ownerVerification(tx, {
                email: user.email,
                firstName: user.name.split(/\s+/)[0],
                token: verificationToken,
                userId: user.id,
            });
        });
        return { message: genericRegistrationMessage };
    },
    async requestPasswordReset(email) {
        try {
            emailService.assertConfigured();
        }
        catch {
            throw new HttpError(503, "Password reset is temporarily unavailable. Please try again later.");
        }
        const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
        if (!user || user.status !== "ACTIVE" || !user.emailVerifiedAt) {
            return { message: "If the account is eligible, a password reset email will be sent." };
        }
        const token = createSecureToken();
        const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60_000);
        await prisma.$transaction(async (tx) => {
            await tx.passwordResetToken.updateMany({
                where: { userId: user.id, usedAt: null },
                data: { usedAt: new Date() },
            });
            await tx.passwordResetToken.create({
                data: { userId: user.id, tokenHash: hashSecureToken(token), expiresAt },
            });
            await emailService.passwordReset(tx, {
                email: user.email,
                firstName: user.name.split(/\s+/)[0],
                token,
                userId: user.id,
            });
        });
        return { message: "If the account is eligible, a password reset email will be sent." };
    },
    async resetPassword(token, password) {
        if (!isStrongPassword(password)) {
            throw new HttpError(400, "Password must be at least 12 characters and include uppercase, lowercase, number, and symbol characters");
        }
        const reset = await prisma.passwordResetToken.findUnique({
            where: { tokenHash: hashSecureToken(token) },
            include: { user: true },
        });
        if (!reset || reset.usedAt || reset.expiresAt <= new Date() || reset.user.status !== "ACTIVE") {
            throw new HttpError(400, "This password reset link is invalid or expired");
        }
        const passwordHash = await bcrypt.hash(password, 12);
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.passwordResetToken.updateMany({
                where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } },
                data: { usedAt: new Date() },
            });
            if (!claimed.count)
                throw new HttpError(400, "This password reset link is invalid or expired");
            await tx.passwordResetToken.updateMany({
                where: { userId: reset.userId, usedAt: null },
                data: { usedAt: new Date() },
            });
            await tx.user.update({
                where: { id: reset.userId },
                data: {
                    passwordHash,
                    passwordChangedAt: new Date(),
                    sessionVersion: { increment: 1 },
                },
            });
            await tx.auditLog.create({
                data: { actorId: reset.userId, action: "password_reset_completed" },
            });
            await emailService.activationConfirmation(tx, {
                email: reset.user.email,
                firstName: reset.user.name.split(/\s+/)[0],
                userId: reset.userId,
            });
        });
        return { ok: true };
    },
    async validateInvitation(token) {
        const invitation = await prisma.accountInvitation.findUnique({
            where: { tokenHash: hashSecureToken(token) },
            include: {
                business: true,
                user: { include: { fundingPartner: true } },
                accountantApplication: { include: { business: true } },
            },
        });
        if (invitation && invitation.expiresAt <= new Date() && ["PENDING", "SENT"].includes(invitation.status)) {
            await prisma.accountInvitation.update({
                where: { id: invitation.id },
                data: { status: "EXPIRED" },
            });
        }
        if (!invitation || !["PENDING", "SENT"].includes(invitation.status)
            || invitation.expiresAt <= new Date() || invitation.usedAt) {
            throw new HttpError(400, "This invitation is invalid, expired, or has already been used");
        }
        const businessName = invitation.business?.name
            ?? invitation.user?.fundingPartner?.organisationName
            ?? invitation.accountantApplication?.business.name
            ?? "SME FinanceHub";
        return {
            email: invitation.email,
            role: roleForClient[invitation.role],
            organisation: businessName,
        };
    },
    async acceptInvitation(token, password) {
        if (!isStrongPassword(password)) {
            throw new HttpError(400, "Password must be at least 12 characters and include uppercase, lowercase, number, and symbol characters");
        }
        const tokenHash = hashSecureToken(token);
        const invitation = await prisma.accountInvitation.findUnique({
            where: { tokenHash },
            include: { user: true },
        });
        if (invitation && invitation.expiresAt <= new Date() && ["PENDING", "SENT"].includes(invitation.status)) {
            await prisma.accountInvitation.update({
                where: { id: invitation.id },
                data: { status: "EXPIRED" },
            });
        }
        if (!invitation || !invitation.user || !["PENDING", "SENT"].includes(invitation.status)
            || invitation.expiresAt <= new Date() || invitation.usedAt
            || invitation.user.status !== "PENDING_ACTIVATION") {
            throw new HttpError(400, "This invitation is invalid, expired, or has already been used");
        }
        const passwordHash = await bcrypt.hash(password, 12);
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.accountInvitation.updateMany({
                where: {
                    id: invitation.id,
                    status: { in: ["PENDING", "SENT"] },
                    usedAt: null,
                    expiresAt: { gt: new Date() },
                },
                data: { status: "ACCEPTED", usedAt: new Date() },
            });
            if (!claimed.count)
                throw new HttpError(400, "This invitation is invalid, expired, or has already been used");
            const updatedUser = await tx.user.update({
                where: { id: invitation.userId },
                data: {
                    passwordHash,
                    passwordChangedAt: new Date(),
                    status: "ACTIVE",
                    sessionVersion: { increment: 1 },
                    activatedAt: new Date(),
                },
            });
            if (invitation.role === "ACCOUNTANT" && invitation.businessId) {
                await tx.user.update({
                    where: { id: updatedUser.id },
                    data: { businessId: invitation.businessId },
                });
                await tx.businessMembership.upsert({
                    where: { businessId_userId: { businessId: invitation.businessId, userId: updatedUser.id } },
                    create: {
                        businessId: invitation.businessId,
                        userId: updatedUser.id,
                        role: "ACCOUNTANT",
                    },
                    update: { role: "ACCOUNTANT", revokedAt: null },
                });
            }
            if (invitation.accountantApplicationId) {
                const application = await tx.accountantApplication.update({
                    where: { id: invitation.accountantApplicationId },
                    data: { applicantId: updatedUser.id },
                    select: { submittedById: true, firstName: true, lastName: true },
                });
                await tx.notification.create({
                    data: {
                        userId: application.submittedById,
                        title: "Accountant invitation accepted",
                        message: `${application.firstName} ${application.lastName} activated their account.`,
                        link: "/app/settings/team",
                    },
                });
            }
            await emailService.activationConfirmation(tx, {
                email: updatedUser.email,
                firstName: updatedUser.name.split(/\s+/)[0],
                userId: updatedUser.id,
            });
            await tx.auditLog.create({
                data: { actorId: updatedUser.id, action: "account_invitation_accepted", target: invitation.id },
            });
        });
        const full = await prisma.user.findUnique({
            where: { id: invitation.userId },
            include: { business: true },
        });
        if (!full)
            throw new HttpError(404, "Account not found");
        return {
            token: signToken({ sub: full.id, role: roleForClient[full.role], sessionVersion: full.sessionVersion }),
            user: publicUser(full),
        };
    },
    async resendInvitation(invitationId, actorId) {
        try {
            emailService.assertConfigured();
        }
        catch {
            throw new HttpError(503, "Email delivery is temporarily unavailable. Please try again later.");
        }
        const previous = await prisma.accountInvitation.findUnique({
            where: { id: invitationId },
            include: {
                business: true,
                user: { include: { fundingPartner: true } },
                accountantApplication: { include: { business: true } },
            },
        });
        if (!previous || !previous.user)
            throw new HttpError(404, "Invitation not found");
        if (previous.role !== "ACCOUNTANT" && previous.role !== "FUNDING_PARTNER") {
            throw new HttpError(409, "This invitation type cannot be resent");
        }
        const invitedUser = previous.user;
        const invitationRole = previous.role;
        if (previous.status === "ACCEPTED" || previous.status === "REVOKED") {
            throw new HttpError(409, "This invitation can no longer be resent");
        }
        const token = createSecureToken();
        const expiry = new Date(Date.now() + env.INVITATION_TOKEN_TTL_MINUTES * 60_000);
        const organisation = previous.business?.name
            ?? invitedUser.fundingPartner?.organisationName
            ?? "SME FinanceHub";
        const [firstName = "there"] = invitedUser.name.split(/\s+/);
        let nextInvitationId = "";
        await prisma.$transaction(async (tx) => {
            await tx.accountInvitation.update({
                where: { id: previous.id },
                data: { status: "REVOKED" },
            });
            const next = await tx.accountInvitation.create({
                data: {
                    email: previous.email,
                    role: invitationRole,
                    userId: previous.userId,
                    businessId: previous.businessId,
                    accountantApplicationId: previous.accountantApplicationId,
                    createdById: actorId,
                    tokenHash: hashSecureToken(token),
                    expiresAt: expiry,
                },
            });
            nextInvitationId = next.id;
            await emailService.invitation(tx, {
                email: previous.email,
                firstName,
                role: invitationRole,
                organisation,
                token,
                userId: invitedUser.id,
                invitationId: next.id,
            });
            await tx.auditLog.create({
                data: { actorId, action: "account_invitation_resent", target: next.id },
            });
        });
        return { id: nextInvitationId, status: "PENDING" };
    },
    async me(userId) {
        const user = await prisma.user.findUnique({ where: { id: userId }, include: { business: true } });
        if (!user)
            throw new HttpError(404, "User not found");
        return publicUser(user);
    },
    async updateName(userId, name) {
        await prisma.user.update({ where: { id: userId }, data: { name: name.trim() } });
        return this.me(userId);
    },
};
