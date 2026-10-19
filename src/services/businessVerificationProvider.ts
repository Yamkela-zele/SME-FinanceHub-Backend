import { randomUUID } from "node:crypto"

export type VerificationProviderRequest = {
  registrationStatus: "REGISTERED" | "UNREGISTERED"
  registrationNumber: string | null
  businessName: string
  businessType: string
}

export type VerificationProviderResult = {
  provider: string
  overallStatus: "PENDING_MANUAL_REVIEW"
  businessVerificationStatus: "PENDING"
  representativeVerificationStatus: "PENDING"
  providerReference: string
  providerCheckedAt: null
}

export interface BusinessVerificationProvider {
  submit(request: VerificationProviderRequest): Promise<VerificationProviderResult>
}

const manualReviewProvider: BusinessVerificationProvider = {
  async submit(_request) {
    return {
      provider: "MANUAL_REVIEW",
      overallStatus: "PENDING_MANUAL_REVIEW",
      businessVerificationStatus: "PENDING",
      representativeVerificationStatus: "PENDING",
      providerReference: `MANUAL-${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`,
      providerCheckedAt: null,
    }
  },
}

export function getBusinessVerificationProvider(): BusinessVerificationProvider {
  return manualReviewProvider
}
