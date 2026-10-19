import { createHash } from "node:crypto";
import { prisma } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";
async function consume(key, windowMs, max) {
    const now = new Date();
    const resetAt = new Date(now.getTime() + windowMs);
    const bucket = await prisma.rateLimitBucket.findUnique({ where: { key } });
    if (!bucket) {
        try {
            await prisma.rateLimitBucket.create({ data: { key, count: 1, resetAt } });
            return;
        }
        catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
                return consume(key, windowMs, max);
            }
            throw error;
        }
    }
    if (bucket.resetAt <= now) {
        const reset = await prisma.rateLimitBucket.updateMany({
            where: { key, resetAt: { lte: now } },
            data: { count: 1, resetAt },
        });
        if (reset.count)
            return;
    }
    const incremented = await prisma.rateLimitBucket.updateMany({
        where: { key, resetAt: { gt: now }, count: { lt: max } },
        data: { count: { increment: 1 } },
    });
    if (!incremented.count)
        throw new HttpError(429, "Too many requests. Please try again later.");
}
export function rateLimit(options) {
    return (req, _res, next) => {
        const address = req.ip ?? req.socket.remoteAddress ?? "unknown";
        const route = `${req.baseUrl}${req.path}`;
        const key = createHash("sha256").update(`${address}:${route}`).digest("hex");
        void consume(key, options.windowMs, options.max).then(() => next(), next);
    };
}
