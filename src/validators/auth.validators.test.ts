import { describe, expect, it } from "vitest"
import {
  createPasswordSchema,
  registerOwnerSchema,
} from "./auth.validators.js"
import { createSecureToken, hashSecureToken, isStrongPassword } from "../utils/secureToken.js"

const validOwnerRegistration = {
  firstName: "Amina",
  lastName: "Dlamini",
  phone: "+27123456789",
  email: "AMINA@example.co.za",
  tradingName: "Amina Foods",
  businessType: "SOLE_PROPRIETOR",
  industry: "Food services",
  registrationStatus: "UNREGISTERED",
  address: "10 Main Street",
  province: "Gauteng",
  municipality: "Johannesburg",
  description: "A local food services business.",
  termsAccepted: true,
  privacyAcknowledged: true,
  applicantRelationship: "OWNER_PROPRIETOR",
  authorityDescription: "I own and manage this unregistered business.",
}

describe("owner registration validation", () => {
  it("accepts owner-only registration without asking for a password or CIPC number", () => {
    const result = registerOwnerSchema.safeParse(validOwnerRegistration)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.email).toBe("amina@example.co.za")
      expect("password" in result.data).toBe(false)
      expect("role" in result.data).toBe(false)
    }
  })

  it("rejects caller-selected roles and passwords", () => {
    expect(registerOwnerSchema.safeParse({
      ...validOwnerRegistration,
      role: "SYSTEM_ADMIN",
      password: "SecretPassword!2026",
    }).success).toBe(false)
  })

  it("requires accepted terms and privacy acknowledgement", () => {
    expect(registerOwnerSchema.safeParse({
      ...validOwnerRegistration,
      termsAccepted: false,
    }).success).toBe(false)
  })

  it("does not require a CIPC number when not applicable", () => {
    expect(registerOwnerSchema.safeParse({
      ...validOwnerRegistration,
      registrationStatus: "REGISTERED",
    }).success).toBe(true)
  })
})

describe("secure onboarding tokens and passwords", () => {
  it("creates unguessable tokens and stores their deterministic digest", () => {
    const first = createSecureToken()
    const second = createSecureToken()
    expect(first).not.toBe(second)
    expect(first.length).toBeGreaterThanOrEqual(40)
    expect(hashSecureToken(first)).toHaveLength(64)
    expect(hashSecureToken(first)).toBe(hashSecureToken(first))
    expect(hashSecureToken(first)).not.toBe(first)
  })

  it("enforces strong password setup values", () => {
    expect(isStrongPassword("FinanceHub!Secure2026")).toBe(true)
    expect(isStrongPassword("password")).toBe(false)
    expect(createPasswordSchema.safeParse({
      token: createSecureToken(),
      password: "password",
    }).success).toBe(false)
  })
})
