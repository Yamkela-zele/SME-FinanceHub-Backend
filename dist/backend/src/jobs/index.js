import cron from "node-cron";
import { prisma } from "../config/db.js";
import { env } from "../config/env.js";
import { emailService } from "../services/email.service.js";
import { expireBusinessVerifications } from "../services/businessVerification.service.js";
import { purgeExpiredVerificationEvidence } from "../services/verificationEvidence.service.js";
export function startJobs() {
    // Daily at 01:00: flag unpaid invoices past their due date as overdue
    cron.schedule("0 1 * * *", async () => {
        try {
            await prisma.invoice.updateMany({
                where: { status: { in: ["SENT", "PARTIALLY_PAID"] }, dueDate: { lt: new Date() } },
                data: { status: "OVERDUE" },
            });
            await prisma.rateLimitBucket.deleteMany({ where: { resetAt: { lt: new Date() } } });
            await expireBusinessVerifications();
            await purgeExpiredVerificationEvidence();
        }
        catch (error) {
            console.error("Daily maintenance job failed", error);
        }
    });
    if (env.EMAIL_PROVIDER_API_KEY && env.EMAIL_OUTBOX_ENCRYPTION_KEY) {
        cron.schedule("* * * * *", async () => {
            try {
                await emailService.deliverPending();
            }
            catch (error) {
                console.error("Email outbox delivery failed", error);
            }
        });
    }
    else {
        console.warn("Email delivery is not configured; registration and invitations are unavailable.");
    }
}
