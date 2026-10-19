import { describe, expect, it } from "vitest";
import { getBusinessVerificationProvider } from "./businessVerificationProvider.js";
describe("manual verification provider", () => {
    it("never treats an applicant's claim as automatically verified", async () => {
        const result = await getBusinessVerificationProvider().submit({
            registrationStatus: "REGISTERED",
            registrationNumber: "2024/123456/07",
            businessName: "Example Business",
            businessType: "PRIVATE_COMPANY",
        });
        expect(result.provider).toBe("MANUAL_REVIEW");
        expect(result.overallStatus).toBe("PENDING_MANUAL_REVIEW");
        expect(result.businessVerificationStatus).toBe("PENDING");
        expect(result.representativeVerificationStatus).toBe("PENDING");
        expect(result.providerCheckedAt).toBeNull();
    });
});
