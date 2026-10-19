import { prisma } from "../config/db.js";
import { HttpError } from "./httpError.js";
const completedStatuses = new Set([
    "AUTOMATICALLY_VERIFIED",
    "MANUALLY_VERIFIED",
    "VERIFIED_WITH_LIMITATIONS",
]);
export function isBusinessVerificationComplete(verification) {
    if (!verification || !completedStatuses.has(verification.overallStatus)
        || verification.representativeVerificationStatus !== "VERIFIED"
        || (verification.expiresAt && verification.expiresAt <= new Date()))
        return false;
    return verification.registrationStatus === "REGISTERED"
        ? verification.businessVerificationStatus === "VERIFIED"
        : verification.registrationStatus === "UNREGISTERED"
            && verification.businessVerificationStatus === "NOT_APPLICABLE"
            && verification.overallStatus === "VERIFIED_WITH_LIMITATIONS";
}
export async function assertBusinessVerificationComplete(businessId) {
    const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { verificationStatus: true, verification: true },
    });
    if (!business || business.verificationStatus !== "VERIFIED"
        || !isBusinessVerificationComplete(business.verification)) {
        throw new HttpError(403, "Complete business and representative verification before using this feature");
    }
}
export async function businessIdsForUser(userId, role) {
    if (role === "admin")
        return null;
    const now = new Date();
    if (role === "owner" || role === "accountant") {
        const memberships = await prisma.businessMembership.findMany({
            where: {
                userId,
                revokedAt: null,
                role: role === "owner" ? "BUSINESS_OWNER" : "ACCOUNTANT",
                business: { users: { some: { id: userId, status: "ACTIVE" } } },
            },
            select: { businessId: true },
        });
        return memberships.map((membership) => membership.businessId);
    }
    const shares = await prisma.businessShare.findMany({
        where: {
            fundingPartner: { userId, user: { status: "ACTIVE" } },
            business: { verificationStatus: "VERIFIED" },
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        include: {
            business: {
                select: {
                    verificationStatus: true,
                    verification: {
                        select: {
                            registrationStatus: true,
                            businessVerificationStatus: true,
                            representativeVerificationStatus: true,
                            overallStatus: true,
                            expiresAt: true,
                        },
                    },
                },
            },
        },
    });
    return [...new Set(shares
            .filter((share) => share.business.verificationStatus === "VERIFIED"
            && isBusinessVerificationComplete(share.business.verification))
            .map((share) => share.businessId))];
}
export async function assertBusinessAccess(userId, role, businessId) {
    const ids = await businessIdsForUser(userId, role);
    if (ids && !ids.includes(businessId))
        throw new HttpError(403, "You do not have access to this business");
}
