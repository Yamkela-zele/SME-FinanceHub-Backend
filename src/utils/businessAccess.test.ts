import { describe, expect, it } from "vitest"
import { isBusinessVerificationComplete } from "./businessAccess.js"

describe("business verification access policy", () => {
  it("requires business registration and representative authority checks", () => {
    expect(isBusinessVerificationComplete({
      registrationStatus: "REGISTERED",
      businessVerificationStatus: "VERIFIED",
      representativeVerificationStatus: "VERIFIED",
      overallStatus: "MANUALLY_VERIFIED",
    })).toBe(true)
    expect(isBusinessVerificationComplete({
      registrationStatus: "REGISTERED",
      businessVerificationStatus: "VERIFIED",
      representativeVerificationStatus: "PENDING",
      overallStatus: "MANUALLY_VERIFIED",
    })).toBe(false)
    expect(isBusinessVerificationComplete({
      registrationStatus: "REGISTERED",
      businessVerificationStatus: "PENDING",
      representativeVerificationStatus: "VERIFIED",
      overallStatus: "MANUALLY_VERIFIED",
    })).toBe(false)
  })

  it("does not represent unregistered businesses as CIPC-verified", () => {
    expect(isBusinessVerificationComplete({
      registrationStatus: "UNREGISTERED",
      businessVerificationStatus: "NOT_APPLICABLE",
      representativeVerificationStatus: "VERIFIED",
      overallStatus: "VERIFIED_WITH_LIMITATIONS",
    })).toBe(true)
    expect(isBusinessVerificationComplete({
      registrationStatus: "UNREGISTERED",
      businessVerificationStatus: "VERIFIED",
      representativeVerificationStatus: "VERIFIED",
      overallStatus: "MANUALLY_VERIFIED",
    })).toBe(false)
  })

  it("does not allow an expired verification", () => {
    expect(isBusinessVerificationComplete({
      registrationStatus: "REGISTERED",
      businessVerificationStatus: "VERIFIED",
      representativeVerificationStatus: "VERIFIED",
      overallStatus: "MANUALLY_VERIFIED",
      expiresAt: new Date(Date.now() - 1000),
    })).toBe(false)
  })
})
