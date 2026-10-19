import { randomUUID } from "node:crypto";
const manualReviewProvider = {
    async submit(_request) {
        return {
            provider: "MANUAL_REVIEW",
            overallStatus: "PENDING_MANUAL_REVIEW",
            businessVerificationStatus: "PENDING",
            representativeVerificationStatus: "PENDING",
            providerReference: `MANUAL-${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`,
            providerCheckedAt: null,
        };
    },
};
export function getBusinessVerificationProvider() {
    return manualReviewProvider;
}
