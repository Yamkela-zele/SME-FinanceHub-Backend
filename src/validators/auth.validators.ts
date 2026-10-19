import { z } from "zod"

const passwordSchema = z.string()
  .min(12)
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/\d/, "Password must contain a number")
  .regex(/[^A-Za-z0-9]/, "Password must contain a symbol")

export const loginSchema = z.object({
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  password: z.string().min(1),
}).strict()

export const registerOwnerSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  legalName: z.string().trim().max(160).optional(),
  tradingName: z.string().trim().max(160).optional(),
  businessType: z.enum([
    "SOLE_PROPRIETOR",
    "PRIVATE_COMPANY",
    "PARTNERSHIP",
    "COOPERATIVE",
    "NON_PROFIT",
    "OTHER",
  ]),
  industry: z.string().trim().min(2).max(100),
  registrationStatus: z.enum(["REGISTERED", "UNREGISTERED"]),
  registrationNumber: z.string().trim().max(80).optional(),
  applicantRelationship: z.enum([
    "DIRECTOR",
    "OWNER_PROPRIETOR",
    "AUTHORIZED_REPRESENTATIVE",
    "OTHER_AUTHORIZED_ROLE",
    "UNREGISTERED_OWNER",
  ]),
  authorityDescription: z.string().trim().min(10).max(1000),
  address: z.string().trim().min(4).max(300),
  province: z.enum([
    "Eastern Cape",
    "Free State",
    "Gauteng",
    "KwaZulu-Natal",
    "Limpopo",
    "Mpumalanga",
    "Northern Cape",
    "North West",
    "Western Cape",
  ]),
  municipality: z.string().trim().min(2).max(100),
  description: z.string().trim().min(10).max(2000),
  website: z.union([z.string().url().max(300), z.literal("")]).optional(),
  termsAccepted: z.literal(true),
  privacyAcknowledged: z.literal(true),
}).strict().superRefine((data, context) => {
  if (!data.legalName && !data.tradingName) {
    context.addIssue({ code: "custom", message: "Enter a legal or trading business name", path: ["legalName"] })
  }
  if (data.registrationStatus === "UNREGISTERED" && data.registrationNumber) {
    context.addIssue({ code: "custom", message: "Do not enter a CIPC number for an unregistered business", path: ["registrationNumber"] })
  }
})

export const verifyEmailSchema = z.object({ token: z.string().min(32).max(200) }).strict()
export const createPasswordSchema = z.object({
  token: z.string().min(32).max(200),
  password: passwordSchema,
}).strict()
export const invitationSchema = z.object({ token: z.string().min(32).max(200) }).strict()
export const acceptInvitationSchema = z.object({
  token: z.string().min(32).max(200),
  password: passwordSchema,
}).strict()
export const resendVerificationSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
}).strict()
export const requestPasswordResetSchema = resendVerificationSchema
export const resetPasswordSchema = acceptInvitationSchema
