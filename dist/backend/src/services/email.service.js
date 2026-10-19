import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { prisma } from "../config/db.js";
const encryptionKey = () => {
    if (!env.EMAIL_OUTBOX_ENCRYPTION_KEY)
        throw new Error("Email outbox encryption is not configured");
    return Buffer.from(env.EMAIL_OUTBOX_ENCRYPTION_KEY, "hex");
};
function encrypt(content) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(content), "utf8"), cipher.final()]);
    return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${ciphertext.toString("hex")}`;
}
function decrypt(value) {
    const [ivHex, tagHex, ciphertextHex] = value.split(".");
    if (!ivHex || !tagHex || !ciphertextHex)
        throw new Error("Invalid encrypted email payload");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(ciphertextHex, "hex")),
        decipher.final(),
    ]).toString("utf8"));
}
const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
})[character]);
function brandedEmail(title, body, link) {
    const safeTitle = escapeHtml(title);
    const safeBody = escapeHtml(body);
    const safeHref = link?.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const action = link && safeHref
        ? `<p><a href="${safeHref}" style="display:inline-block;padding:12px 20px;background:#102a43;color:#fff;text-decoration:none;border-radius:8px">${escapeHtml(link.label)}</a></p>`
        : "";
    return {
        html: `<div style="font-family:Arial,sans-serif;color:#102a43;line-height:1.6"><h1 style="font-size:22px">${safeTitle}</h1><p>${safeBody}</p>${action}<p style="color:#667085;font-size:12px">SME FinanceHub</p></div>`,
        text: `${title}\n\n${body}${link ? `\n\n${link.label}: ${link.href}` : ""}\n\nSME FinanceHub`,
    };
}
function assertConfigured() {
    if (!env.EMAIL_PROVIDER_API_KEY)
        throw new Error("Email provider is not configured");
    if (!env.EMAIL_OUTBOX_ENCRYPTION_KEY)
        throw new Error("Email outbox encryption is not configured");
}
export const emailService = {
    assertConfigured,
    enqueue(tx, input) {
        return tx.emailDeliveryLog.create({
            data: {
                userId: input.userId,
                invitationId: input.invitationId,
                toEmail: input.to,
                template: input.template,
                subject: input.subject,
                encryptedPayload: encrypt(input.content),
            },
        });
    },
    ownerVerification(tx, input) {
        const link = `${env.FRONTEND_URL}/verify-email?token=${encodeURIComponent(input.token)}`;
        return this.enqueue(tx, {
            to: input.email,
            userId: input.userId,
            template: "owner-email-verification",
            subject: "Verify your SME FinanceHub email",
            content: brandedEmail("Verify your email address", `Hello ${input.firstName}, verify your email and create your password to continue your SME FinanceHub registration.`, { label: "Verify my email", href: link }),
        });
    },
    invitation(tx, input) {
        const link = `${env.FRONTEND_URL}/accept-invitation?token=${encodeURIComponent(input.token)}`;
        const isAccountant = input.role === "ACCOUNTANT";
        const subject = isAccountant
            ? "Your SME FinanceHub Accountant Invitation Has Been Approved"
            : "Invitation to Join SME FinanceHub as a Funding Partner";
        const body = isAccountant
            ? `Hello ${input.firstName}, your request to join ${input.organisation} as an Accountant / Finance Officer has been approved. Use the secure link to create your password.`
            : `Hello ${input.firstName}, you have been invited to join SME FinanceHub as a Funding Partner representing ${input.organisation}. Use the secure link to create your password.`;
        return this.enqueue(tx, {
            to: input.email,
            userId: input.userId,
            invitationId: input.invitationId,
            template: isAccountant ? "accountant-invitation" : "funding-partner-invitation",
            subject,
            content: brandedEmail(body, "This single-use activation link is time-limited. Do not share it.", {
                label: "Create my password",
                href: link,
            }),
        });
    },
    activationConfirmation(tx, input) {
        return this.enqueue(tx, {
            to: input.email,
            userId: input.userId,
            template: "account-activation-confirmation",
            subject: "Your SME FinanceHub account is active",
            content: brandedEmail("Your account is active", `Hello ${input.firstName}, your SME FinanceHub account has been activated. You can now sign in using your registered email address.`),
        });
    },
    notice(tx, input) {
        return this.enqueue(tx, {
            to: input.email,
            userId: input.userId,
            template: "account-notice",
            subject: input.title,
            content: brandedEmail(`Hello ${input.name}`, `${input.title}: ${input.message}`),
        });
    },
    passwordReset(tx, input) {
        const link = `${env.FRONTEND_URL}/reset-password?token=${encodeURIComponent(input.token)}`;
        return this.enqueue(tx, {
            to: input.email,
            userId: input.userId,
            template: "password-reset",
            subject: "Reset your SME FinanceHub password",
            content: brandedEmail("Reset your password", `Hello ${input.firstName}, use the secure link below to reset your SME FinanceHub password. If you did not request this, ignore this email.`, { label: "Reset password", href: link }),
        });
    },
    async deliverPending(limit = 10) {
        const now = new Date();
        const pending = await prisma.emailDeliveryLog.findMany({
            where: {
                status: { in: ["QUEUED", "FAILED"] },
                nextAttemptAt: { lte: now },
                attempts: { lt: 8 },
            },
            orderBy: { createdAt: "asc" },
            take: limit,
        });
        if (pending.length)
            assertConfigured();
        for (const entry of pending) {
            const claimed = await prisma.emailDeliveryLog.updateMany({
                where: { id: entry.id, status: { in: ["QUEUED", "FAILED"] } },
                data: { status: "SENDING", attempts: { increment: 1 } },
            });
            if (!claimed.count)
                continue;
            try {
                if (entry.invitationId) {
                    const invitation = await prisma.accountInvitation.findUnique({
                        where: { id: entry.invitationId },
                        select: { status: true, expiresAt: true },
                    });
                    if (!invitation || !["PENDING", "SENT"].includes(invitation.status)
                        || invitation.expiresAt <= new Date()) {
                        await prisma.$transaction(async (tx) => {
                            await tx.emailDeliveryLog.update({
                                where: { id: entry.id },
                                data: { status: "FAILED", lastError: "Invitation is no longer valid" },
                            });
                            if (invitation && invitation.expiresAt <= new Date()) {
                                await tx.accountInvitation.updateMany({
                                    where: { id: entry.invitationId, status: { in: ["PENDING", "SENT"] } },
                                    data: { status: "EXPIRED" },
                                });
                            }
                        });
                        continue;
                    }
                }
                const content = decrypt(entry.encryptedPayload);
                const response = await fetch("https://api.resend.com/emails", {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${env.EMAIL_PROVIDER_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        from: env.EMAIL_FROM,
                        to: [entry.toEmail],
                        subject: entry.subject,
                        html: content.html,
                        text: content.text,
                    }),
                    signal: AbortSignal.timeout(10_000),
                });
                if (!response.ok) {
                    await prisma.emailDeliveryLog.update({
                        where: { id: entry.id },
                        data: {
                            status: "FAILED",
                            lastError: `Email provider returned HTTP ${response.status}`,
                            nextAttemptAt: new Date(Date.now() + Math.min(60_000 * 2 ** entry.attempts, 86_400_000)),
                        },
                    });
                    continue;
                }
                const result = await response.json().catch(() => ({}));
                await prisma.$transaction(async (tx) => {
                    await tx.emailDeliveryLog.update({
                        where: { id: entry.id },
                        data: {
                            status: "SENT",
                            providerMessageId: result.id,
                            sentAt: new Date(),
                            lastError: null,
                        },
                    });
                    if (entry.invitationId) {
                        await tx.accountInvitation.updateMany({
                            where: { id: entry.invitationId, status: "PENDING" },
                            data: { status: "SENT", sentAt: new Date() },
                        });
                    }
                });
            }
            catch (error) {
                await prisma.emailDeliveryLog.update({
                    where: { id: entry.id },
                    data: {
                        status: "FAILED",
                        lastError: error instanceof Error ? error.message.slice(0, 500) : "Email delivery failed",
                        nextAttemptAt: new Date(Date.now() + Math.min(60_000 * 2 ** entry.attempts, 86_400_000)),
                    },
                });
            }
        }
        await prisma.emailDeliveryLog.updateMany({
            where: { status: { in: ["QUEUED", "FAILED"] }, attempts: { gte: 8 } },
            data: { nextAttemptAt: new Date("9999-12-31T23:59:59.999Z") },
        });
        await prisma.accountInvitation.updateMany({
            where: {
                status: { in: ["PENDING", "SENT"] },
                AND: [
                    { emailDeliveries: { some: { attempts: { gte: 8 }, status: "FAILED" } } },
                    { emailDeliveries: { every: { attempts: { gte: 8 }, status: "FAILED" } } },
                ],
            },
            data: { status: "FAILED" },
        });
    },
};
