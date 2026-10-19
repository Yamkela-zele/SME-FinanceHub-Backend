import { randomUUID } from "node:crypto"
import { Router } from "express"
import multer from "multer"
import { Prisma, type VerificationRequestStatus } from "@prisma/client"
import { z } from "zod"
import { prisma } from "../../config/db.js"
import { env } from "../../config/env.js"
import { requireAuth, requireRole } from "../../middleware/auth.js"
import { rateLimit } from "../../middleware/rateLimit.js"
import { validateBody } from "../../middleware/validate.js"
import { emailService } from "../../services/email.service.js"
import { getBusinessVerificationProvider } from "../../services/businessVerificationProvider.js"
import {
  evidenceDigest,
  readVerificationEvidence,
  removeVerificationEvidence,
  storeVerificationEvidence,
  verificationEvidenceLimits,
  verifyEvidenceFile,
} from "../../services/verificationEvidence.service.js"
import { asyncHandler } from "../../utils/asyncHandler.js"
import { businessIdFor } from "../../utils/ownerBusiness.js"
import { HttpError } from "../../utils/httpError.js"

export const businessVerificationRoutes = Router()
export const businessVerificationAdminRoutes = Router()

const statusMessages: Record<string, { title: string; message: (businessName: string, reason?: string | null) => string }> = {
  PENDING_MANUAL_REVIEW: {
    title: "Business verification request received",
    message: (name) => `Your request for ${name} has been received and is queued for manual review.`,
  },
  VERIFICATION_IN_PROGRESS: {
    title: "Business verification review started",
    message: (name) => `An administrator has started reviewing the verification request for ${name}.`,
  },
  ADDITIONAL_INFORMATION_REQUIRED: {
    title: "More information is required",
    message: (_name, reason) => reason || "Please sign in to review the additional information requested for your business verification.",
  },
  MANUALLY_VERIFIED: {
    title: "Business verification complete",
    message: (name) => `The required business registration and representative authority checks for ${name} have been completed successfully.`,
  },
  VERIFIED_WITH_LIMITATIONS: {
    title: "Business verification review complete",
    message: (name) => `The alternative verification route for ${name} has been reviewed. Some CIPC-specific services may not be available.`,
  },
  UNABLE_TO_VERIFY: {
    title: "We could not complete automated verification",
    message: (_name, reason) => reason || "Automated verification was unavailable. Your request is available for manual review.",
  },
  VERIFICATION_FAILED: {
    title: "Business verification could not be completed",
    message: (_name, reason) => reason || "Please review your business details and submit a corrected verification request.",
  },
  REJECTED: {
    title: "Business verification request not approved",
    message: (_name, reason) => reason || "Your verification request was not approved. Sign in to review the reason and next steps.",
  },
}

const ownerSubmissionSchema = z.object({
  registrationStatus: z.enum(["REGISTERED", "UNREGISTERED"]),
  registrationNumber: z.string().trim().max(80).optional(),
  submittedBusinessName: z.string().trim().min(2).max(160),
  businessType: z.string().trim().min(2).max(100),
  applicantRelationship: z.enum([
    "DIRECTOR",
    "OWNER_PROPRIETOR",
    "AUTHORIZED_REPRESENTATIVE",
    "OTHER_AUTHORIZED_ROLE",
    "UNREGISTERED_OWNER",
  ]),
  authorityDescription: z.string().trim().min(10).max(1000),
  consentAccepted: z.literal(true),
}).strict().superRefine((value, context) => {
  if (value.registrationStatus === "REGISTERED" && !value.registrationNumber?.trim()) {
    context.addIssue({ code: "custom", message: "Enter the business registration number", path: ["registrationNumber"] })
  }
  if (value.registrationStatus === "UNREGISTERED" && value.applicantRelationship !== "UNREGISTERED_OWNER") {
    context.addIssue({ code: "custom", message: "Select the unregistered business verification route", path: ["applicantRelationship"] })
  }
  if (value.registrationStatus === "REGISTERED" && value.applicantRelationship === "UNREGISTERED_OWNER") {
    context.addIssue({ code: "custom", message: "Select a relationship for a registered business", path: ["applicantRelationship"] })
  }
})

const reasonSchema = z.object({ reason: z.string().trim().min(5).max(2000) }).strict()
const evidenceCategorySchema = z.enum(["REGISTRATION", "AUTHORITY", "BUSINESS_ALTERNATIVE"])

function assertVerificationEmailConfigured() {
  try {
    emailService.assertConfigured()
  } catch {
    throw new HttpError(503, "Verification notifications are temporarily unavailable. Please try again later.")
  }
}

const uploadParser = multer({
  storage: multer.memoryStorage(),
  limits: verificationEvidenceLimits,
  fileFilter: (_req, file, done) => {
    if (!["application/pdf", "image/png", "image/jpeg"].includes(file.mimetype)) {
      done(new HttpError(400, "Upload a PDF, PNG or JPEG file"))
      return
    }
    done(null, true)
  },
}).single("file")

const evidenceDto = (evidence: {
  id: string
  category: string
  submissionVersion: number
  originalName: string
  mimeType: string
  sizeBytes: number
  createdAt: Date
  uploadedBy: { name: string }
}, currentSubmissionVersion: number) => ({
  id: evidence.id,
  category: evidence.category,
  originalName: evidence.originalName,
  mimeType: evidence.mimeType,
  sizeBytes: evidence.sizeBytes,
  uploadedAt: evidence.createdAt.toISOString(),
  uploadedBy: evidence.uploadedBy.name,
  isCurrentSubmission: evidence.submissionVersion === currentSubmissionVersion,
})

const caseInclude = {
  business: { select: { name: true, registrationStatus: true, verificationStatus: true } },
  submittedBy: { select: { id: true, name: true, email: true } },
  reviewedBy: { select: { id: true, name: true, email: true } },
  evidence: { include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" as const } },
  events: { include: { actor: { select: { name: true } } }, orderBy: { createdAt: "asc" as const } },
} as const

type VerificationCase = Prisma.BusinessVerificationGetPayload<{ include: typeof caseInclude }>

function dto(item: VerificationCase) {
  return {
    id: item.id,
    provider: item.provider,
    providerReference: item.providerReference,
    submissionVersion: item.submissionVersion,
    registrationNumber: item.registrationNumber,
    submittedBusinessName: item.submittedBusinessName,
    businessType: item.businessType,
    registrationStatus: item.registrationStatus,
    applicantRelationship: item.applicantRelationship,
    authorityDescription: item.authorityDescription,
    businessVerificationStatus: item.businessVerificationStatus,
    representativeVerificationStatus: item.representativeVerificationStatus,
    overallStatus: item.overallStatus,
    providerCheckedAt: item.providerCheckedAt?.toISOString() ?? null,
    reviewedAt: item.reviewedAt?.toISOString() ?? null,
    reviewedBy: item.reviewedBy,
    reviewReason: item.reviewReason,
    lastSuccessfulCheckAt: item.lastSuccessfulCheckAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    business: item.business,
    applicant: item.submittedBy,
    evidence: item.evidence.map((evidence) => evidenceDto(evidence, item.submissionVersion)),
    events: item.events.map((event) => ({
      id: event.id,
      action: event.action,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      reason: event.reason,
      actor: event.actor?.name ?? "System",
      createdAt: event.createdAt.toISOString(),
    })),
  }
}

async function recordEvent(
  tx: Prisma.TransactionClient,
  input: {
    verificationId: string
    actorId: string
    action: string
    fromStatus?: VerificationRequestStatus | null
    toStatus?: VerificationRequestStatus | null
    reason?: string | null
  },
) {
  await tx.businessVerificationEvent.create({
    data: {
      verificationId: input.verificationId,
      actorId: input.actorId,
      action: input.action,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      reason: input.reason,
    },
  })
}

async function notifyOwner(
  tx: Prisma.TransactionClient,
  input: { userId: string; email: string; name: string; businessName: string; status: string; reason?: string | null },
) {
  const notice = statusMessages[input.status]
  if (!notice) return
  const message = notice.message(input.businessName, input.reason)
  await tx.notification.create({
    data: {
      userId: input.userId,
      title: notice.title,
      message,
      link: "/app/settings/business-verification",
      urgent: input.status === "ADDITIONAL_INFORMATION_REQUIRED" || input.status === "REJECTED",
    },
  })
  await emailService.notice(tx, {
    email: input.email,
    name: input.name,
    title: notice.title,
    message,
    userId: input.userId,
  })
}

function mayBeReviewed(status: string) {
  return ["PENDING_MANUAL_REVIEW", "VERIFICATION_IN_PROGRESS"].includes(status)
}

businessVerificationRoutes.get(
  "/current-business",
  requireAuth,
  requireRole("owner"),
  asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth!.userId)
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        name: true,
        tradingName: true,
        businessType: true,
        registrationStatus: true,
        registrationNumber: true,
        ownerRelationship: true,
        ownerAuthorityDescription: true,
        verificationStatus: true,
        verifiedAt: true,
      },
    })
    if (!business) throw new HttpError(404, "Business not found")
    const verification = await prisma.businessVerification.findUnique({
      where: { businessId },
      include: caseInclude,
    })
    res.json({
      data: {
        business: { ...business, verifiedAt: business.verifiedAt?.toISOString() ?? null },
        verification: verification ? dto(verification) : null,
        overallStatus: verification?.overallStatus ?? "NOT_SUBMITTED",
      },
    })
  }),
)

businessVerificationRoutes.post(
  "/",
  requireAuth,
  requireRole("owner"),
  rateLimit({ windowMs: 60 * 60_000, max: 5 }),
  validateBody(ownerSubmissionSchema),
  asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth!.userId)
    const current = await prisma.businessVerification.findUnique({ where: { businessId } })
    if (current && ["PENDING_MANUAL_REVIEW", "VERIFICATION_IN_PROGRESS"].includes(current.overallStatus)) {
      throw new HttpError(409, "A business verification review is already in progress")
    }
    const registrationNumber = req.body.registrationStatus === "REGISTERED"
      ? req.body.registrationNumber?.trim().toUpperCase() ?? null
      : null
    if (registrationNumber) {
      const duplicate = await prisma.business.findFirst({
        where: { registrationNumber, id: { not: businessId } },
        select: { id: true },
      })
      if (duplicate) throw new HttpError(409, "That registration number is already linked to another business workspace")
    }
    const providerResult = await getBusinessVerificationProvider().submit({
      registrationStatus: req.body.registrationStatus,
      registrationNumber,
      businessName: req.body.submittedBusinessName,
      businessType: req.body.businessType,
    })
    const status = providerResult.overallStatus
    const providerReference = current?.providerReference ?? providerResult.providerReference
    const owner = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { name: true, email: true } })
    if (!owner) throw new HttpError(404, "Business owner not found")
    assertVerificationEmailConfigured()

    let result: VerificationCase
    try {
      result = await prisma.$transaction(async (tx) => {
        await tx.business.update({
          where: { id: businessId },
          data: {
            name: req.body.submittedBusinessName,
            businessType: req.body.businessType,
            registrationStatus: req.body.registrationStatus,
            registrationNumber,
            ownerRelationship: req.body.applicantRelationship,
            ownerAuthorityDescription: req.body.authorityDescription,
            verificationStatus: "PENDING",
            verifiedAt: null,
          },
        })
        if (current?.overallStatus === "MANUALLY_VERIFIED" || current?.overallStatus === "VERIFIED_WITH_LIMITATIONS" || current?.overallStatus === "AUTOMATICALLY_VERIFIED") {
          await tx.businessShare.updateMany({
            where: { businessId, revokedAt: null },
            data: { revokedAt: new Date() },
          })
        }
        const submissionFields = {
          submittedByUserId: req.auth!.userId,
          registrationNumber,
          submittedBusinessName: req.body.submittedBusinessName,
          businessType: req.body.businessType,
          registrationStatus: req.body.registrationStatus,
          applicantRelationship: req.body.applicantRelationship,
          authorityDescription: req.body.authorityDescription,
          provider: providerResult.provider,
          businessVerificationStatus: providerResult.businessVerificationStatus,
          representativeVerificationStatus: providerResult.representativeVerificationStatus,
          overallStatus: status,
          reviewedByUserId: null,
          reviewedAt: null,
          reviewReason: null,
          providerCheckedAt: providerResult.providerCheckedAt,
          expiresAt: null,
        }
        let verification: { id: string; providerReference: string }
        if (current) {
          const changed = await tx.businessVerification.updateMany({
            where: {
              id: current.id,
              overallStatus: current.overallStatus,
              submissionVersion: current.submissionVersion,
            },
            data: { ...submissionFields, submissionVersion: { increment: 1 } },
          })
          if (!changed.count) throw new HttpError(409, "This verification request has changed. Refresh and try again.")
          verification = await tx.businessVerification.findUniqueOrThrow({ where: { id: current.id } })
        } else {
          verification = await tx.businessVerification.create({
            data: {
              businessId,
              ...submissionFields,
              providerReference,
            },
          })
        }
        await recordEvent(tx, {
          verificationId: verification.id,
          actorId: req.auth!.userId,
          action: current ? "CORRECTED_AND_RESUBMITTED" : "SUBMITTED",
          fromStatus: current?.overallStatus ?? null,
          toStatus: status,
          reason: "Applicant submitted details for manual review; no authorised automated provider is configured.",
        })
        await notifyOwner(tx, {
          userId: req.auth!.userId,
          email: owner.email,
          name: owner.name,
          businessName: req.body.submittedBusinessName,
          status,
        })
        await tx.auditLog.create({
          data: { actorId: req.auth!.userId, action: "business_verification_submitted", target: verification.providerReference },
        })
        return tx.businessVerification.findUniqueOrThrow({ where: { id: verification.id }, include: caseInclude })
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new HttpError(409, "This verification request or registration number changed during submission. Refresh and try again.")
      }
      throw error
    }
    res.status(202).json({ data: dto(result), providerAvailability: "MANUAL_REVIEW_ONLY" })
  }),
)

businessVerificationRoutes.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const verification = await prisma.businessVerification.findUnique({
      where: { id: req.params.id },
      include: caseInclude,
    })
    if (!verification) throw new HttpError(404, "Verification request not found")
    if (req.auth!.role !== "admin" && verification.submittedByUserId !== req.auth!.userId) {
      throw new HttpError(403, "You do not have access to this verification request")
    }
    res.json({ data: dto(verification) })
  }),
)

businessVerificationRoutes.post(
  "/:id/retry",
  requireAuth,
  requireRole("owner"),
  rateLimit({ windowMs: 60 * 60_000, max: 3 }),
  asyncHandler(async (req, res) => {
    const verification = await prisma.businessVerification.findUnique({
      where: { id: req.params.id },
      include: { business: true },
    })
    if (!verification || verification.submittedByUserId !== req.auth!.userId) {
      throw new HttpError(404, "Verification request not found")
    }
    if (!["UNABLE_TO_VERIFY", "VERIFICATION_FAILED", "EXPIRED"].includes(verification.overallStatus)) {
      throw new HttpError(409, "This verification request cannot be retried")
    }
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.businessVerification.updateMany({
        where: { id: verification.id, overallStatus: verification.overallStatus },
        data: {
          overallStatus: "PENDING_MANUAL_REVIEW",
          businessVerificationStatus: "PENDING",
          representativeVerificationStatus: "PENDING",
          reviewedByUserId: null,
          reviewedAt: null,
          reviewReason: null,
          providerCheckedAt: null,
        },
      })
      if (!changed.count) throw new HttpError(409, "This verification request has already changed")
      await tx.business.update({ where: { id: verification.businessId }, data: { verificationStatus: "PENDING", verifiedAt: null } })
      await recordEvent(tx, {
        verificationId: verification.id,
        actorId: req.auth!.userId,
        action: "MANUAL_REVIEW_RETRY_REQUESTED",
        fromStatus: verification.overallStatus,
        toStatus: "PENDING_MANUAL_REVIEW",
      })
      await tx.auditLog.create({
        data: { actorId: req.auth!.userId, action: "business_verification_retry_requested", target: verification.providerReference },
      })
      return tx.businessVerification.findUniqueOrThrow({ where: { id: verification.id }, include: caseInclude })
    })
    res.status(202).json({ data: dto(updated), providerAvailability: "MANUAL_REVIEW_ONLY" })
  }),
)

businessVerificationRoutes.post(
  "/:id/evidence",
  requireAuth,
  requireRole("owner"),
  rateLimit({ windowMs: 60 * 60_000, max: 10 }),
  (req, res, next) => uploadParser(req, res, (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        next(new HttpError(400, "Evidence files must be no larger than 10 MB"))
      } else next(error)
      return
    }
    next()
  }),
  asyncHandler(async (req, res) => {
    const parsedCategory = evidenceCategorySchema.safeParse(req.body.category)
    if (!parsedCategory.success) throw new HttpError(400, "Choose a valid evidence category")
    if (!req.file) throw new HttpError(400, "Select an evidence file")
    verifyEvidenceFile(req.file)

    const verification = await prisma.businessVerification.findUnique({
      where: { id: req.params.id },
    })
    if (!verification || verification.submittedByUserId !== req.auth!.userId) {
      throw new HttpError(404, "Verification request not found")
    }
    if (["AUTOMATICALLY_VERIFIED", "MANUALLY_VERIFIED", "VERIFIED_WITH_LIMITATIONS", "REJECTED"].includes(verification.overallStatus)) {
      throw new HttpError(409, "Evidence cannot be added to a completed or rejected verification request")
    }
    if (!["PENDING_MANUAL_REVIEW", "ADDITIONAL_INFORMATION_REQUIRED"].includes(verification.overallStatus)) {
      throw new HttpError(409, "Evidence can only be added while awaiting manual review or requested information")
    }
    if (verification.overallStatus === "ADDITIONAL_INFORMATION_REQUIRED") assertVerificationEmailConfigured()

    const evidenceId = randomUUID()
    const storageKey = randomUUID()
    let stored = false
    try {
      await storeVerificationEvidence(storageKey, req.file.buffer)
      stored = true
      const owner = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { name: true, email: true } })
      if (!owner) throw new HttpError(404, "Business owner not found")
      const result = await prisma.$transaction(async (tx) => {
        const changed = await tx.businessVerification.updateMany({
          where: {
            id: verification.id,
            submittedByUserId: req.auth!.userId,
            overallStatus: verification.overallStatus,
            submissionVersion: verification.submissionVersion,
          },
          data: { overallStatus: "PENDING_MANUAL_REVIEW" },
        })
        if (!changed.count) throw new HttpError(409, "Verification request has changed")
        const evidence = await tx.businessVerificationEvidence.create({
          data: {
            id: evidenceId,
            verificationId: verification.id,
            uploadedById: req.auth!.userId,
            category: parsedCategory.data,
            submissionVersion: verification.submissionVersion,
            originalName: req.file!.originalname.slice(0, 255),
            mimeType: req.file!.mimetype,
            sizeBytes: req.file!.size,
            sha256: evidenceDigest(req.file!.buffer),
            storageKey,
          },
          include: { uploadedBy: { select: { name: true } } },
        })
        await recordEvent(tx, {
          verificationId: verification.id,
          actorId: req.auth!.userId,
          action: "EVIDENCE_UPLOADED",
          fromStatus: verification.overallStatus,
          toStatus: "PENDING_MANUAL_REVIEW",
          reason: `Evidence category: ${parsedCategory.data}`,
        })
        if (verification.overallStatus === "ADDITIONAL_INFORMATION_REQUIRED") {
          await notifyOwner(tx, {
            userId: verification.submittedByUserId,
            email: owner.email,
            name: owner.name,
            businessName: verification.submittedBusinessName,
            status: "PENDING_MANUAL_REVIEW",
          })
        }
        await tx.auditLog.create({
          data: { actorId: req.auth!.userId, action: "business_verification_evidence_uploaded", target: verification.providerReference },
        })
        return evidence
      })
      res.status(201).json({ data: evidenceDto(result, verification.submissionVersion) })
    } catch (error) {
      if (stored) {
        try {
          await removeVerificationEvidence(storageKey)
        } catch (cleanupError) {
          console.error("Failed to remove an unreferenced encrypted verification evidence file", cleanupError)
        }
      }
      throw error
    }
  }),
)

businessVerificationRoutes.get(
  "/:id/evidence/:evidenceId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const evidence = await prisma.businessVerificationEvidence.findFirst({
      where: {
        id: req.params.evidenceId,
        verificationId: req.params.id,
        ...(req.auth!.role === "admin" ? {} : { verification: { submittedByUserId: req.auth!.userId } }),
      },
    })
    if (!evidence) throw new HttpError(404, "Evidence not found")
    const file = await readVerificationEvidence(evidence.storageKey)
    res
      .set("Content-Type", evidence.mimeType)
      .set("Content-Length", String(file.length))
      .set("Content-Disposition", `attachment; filename="evidence-${evidence.id}.${evidence.mimeType === "application/pdf" ? "pdf" : evidence.mimeType === "image/png" ? "png" : "jpg"}"`)
      .set("Cache-Control", "private, no-store")
      .set("X-Content-Type-Options", "nosniff")
      .send(file)
  }),
)

businessVerificationAdminRoutes.use(requireAuth, requireRole("admin"))

businessVerificationAdminRoutes.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const verification = await prisma.businessVerification.findUnique({
      where: { id: req.params.id },
      include: caseInclude,
    })
    if (!verification) throw new HttpError(404, "Verification request not found")
    res.json({ data: dto(verification) })
  }),
)

businessVerificationAdminRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
    const status = typeof req.query.status === "string" ? req.query.status : undefined
    const knownStatuses = [
      "PENDING_VERIFICATION", "VERIFICATION_IN_PROGRESS", "AUTOMATICALLY_VERIFIED", "MANUALLY_VERIFIED",
      "VERIFIED_WITH_LIMITATIONS", "PENDING_MANUAL_REVIEW", "ADDITIONAL_INFORMATION_REQUIRED",
      "UNABLE_TO_VERIFY", "VERIFICATION_FAILED", "REJECTED", "EXPIRED",
    ]
    if (status && !knownStatuses.includes(status)) throw new HttpError(400, "Unknown verification status filter")
    const where = status ? { overallStatus: status as never } : {}
    const [total, rows] = await Promise.all([
      prisma.businessVerification.count({ where }),
      prisma.businessVerification.findMany({
        where,
        include: caseInclude,
        orderBy: [{ createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])
    res.json({ data: rows.map(dto), page, pageSize, total })
  }),
)

businessVerificationAdminRoutes.post(
  "/:id/start-review",
  validateBody(reasonSchema),
  asyncHandler(async (req, res) => {
    const current = await prisma.businessVerification.findUnique({
      where: { id: req.params.id },
      include: { business: true, submittedBy: true },
    })
    if (!current) throw new HttpError(404, "Verification request not found")
    if (current.submittedByUserId === req.auth!.userId) throw new HttpError(403, "You cannot review your own verification request")
    if (current.overallStatus !== "PENDING_MANUAL_REVIEW") throw new HttpError(409, "This request is not awaiting manual review")
    assertVerificationEmailConfigured()
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.businessVerification.updateMany({
        where: { id: current.id, overallStatus: "PENDING_MANUAL_REVIEW" },
        data: { overallStatus: "VERIFICATION_IN_PROGRESS", reviewedByUserId: req.auth!.userId, reviewedAt: new Date() },
      })
      if (!changed.count) throw new HttpError(409, "This request has already changed")
      await recordEvent(tx, {
        verificationId: current.id,
        actorId: req.auth!.userId,
        action: "MANUAL_REVIEW_STARTED",
        fromStatus: current.overallStatus,
        toStatus: "VERIFICATION_IN_PROGRESS",
        reason: req.body.reason,
      })
      await notifyOwner(tx, {
        userId: current.submittedByUserId,
        email: current.submittedBy.email,
        name: current.submittedBy.name,
        businessName: current.business.name,
        status: "VERIFICATION_IN_PROGRESS",
      })
      await tx.auditLog.create({
        data: { actorId: req.auth!.userId, action: "business_verification_review_started", target: current.providerReference },
      })
      return tx.businessVerification.findUniqueOrThrow({ where: { id: current.id }, include: caseInclude })
    })
    res.json({ data: dto(updated) })
  }),
)

businessVerificationAdminRoutes.post(
  "/:id/request-information",
  validateBody(reasonSchema),
  asyncHandler(async (req, res) => {
    const current = await prisma.businessVerification.findUnique({
      where: { id: req.params.id },
      include: { business: true, submittedBy: true },
    })
    if (!current) throw new HttpError(404, "Verification request not found")
    if (current.submittedByUserId === req.auth!.userId) throw new HttpError(403, "You cannot review your own verification request")
    if (!mayBeReviewed(current.overallStatus)) throw new HttpError(409, "This request cannot be returned for information")
    assertVerificationEmailConfigured()
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.businessVerification.updateMany({
        where: { id: current.id, overallStatus: current.overallStatus },
        data: {
          overallStatus: "ADDITIONAL_INFORMATION_REQUIRED",
          reviewedByUserId: req.auth!.userId,
          reviewedAt: new Date(),
          reviewReason: req.body.reason,
        },
      })
      if (!changed.count) throw new HttpError(409, "This request has already changed")
      await tx.business.update({ where: { id: current.businessId }, data: { verificationStatus: "PENDING", verifiedAt: null } })
      await tx.businessShare.updateMany({
        where: { businessId: current.businessId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      await recordEvent(tx, {
        verificationId: current.id,
        actorId: req.auth!.userId,
        action: "ADDITIONAL_INFORMATION_REQUESTED",
        fromStatus: current.overallStatus,
        toStatus: "ADDITIONAL_INFORMATION_REQUIRED",
        reason: req.body.reason,
      })
      await notifyOwner(tx, {
        userId: current.submittedByUserId,
        email: current.submittedBy.email,
        name: current.submittedBy.name,
        businessName: current.business.name,
        status: "ADDITIONAL_INFORMATION_REQUIRED",
        reason: req.body.reason,
      })
      await tx.auditLog.create({
        data: { actorId: req.auth!.userId, action: "business_verification_information_requested", target: current.providerReference },
      })
      return tx.businessVerification.findUniqueOrThrow({ where: { id: current.id }, include: caseInclude })
    })
    res.json({ data: dto(updated) })
  }),
)

businessVerificationAdminRoutes.post(
  "/:id/approve",
  validateBody(reasonSchema),
  asyncHandler(async (req, res) => {
    const current = await prisma.businessVerification.findUnique({
      where: { id: req.params.id },
      include: { business: true, submittedBy: true, evidence: true },
    })
    if (!current) throw new HttpError(404, "Verification request not found")
    if (current.submittedByUserId === req.auth!.userId) throw new HttpError(403, "You cannot approve your own verification request")
    if (!mayBeReviewed(current.overallStatus)) throw new HttpError(409, "This request is not awaiting a verification decision")
    assertVerificationEmailConfigured()
    const currentEvidence = current.evidence.filter((item) => item.submissionVersion === current.submissionVersion)
    if (current.registrationStatus === "REGISTERED") {
      if (!currentEvidence.some((item) => item.category === "REGISTRATION")) {
        throw new HttpError(409, "Registration evidence is required before approval")
      }
    } else if (!currentEvidence.some((item) => item.category === "BUSINESS_ALTERNATIVE")) {
      throw new HttpError(409, "Alternative business evidence is required for an unregistered business")
    }
    if (!currentEvidence.some((item) => item.category === "AUTHORITY")) {
      throw new HttpError(409, "Representative authority evidence is required before approval")
    }

    const finalStatus = current.registrationStatus === "REGISTERED" ? "MANUALLY_VERIFIED" : "VERIFIED_WITH_LIMITATIONS"
    const businessStatus = current.registrationStatus === "REGISTERED" ? "VERIFIED" : "NOT_APPLICABLE"
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.businessVerification.updateMany({
        where: { id: current.id, overallStatus: current.overallStatus },
        data: {
          overallStatus: finalStatus,
          businessVerificationStatus: businessStatus,
          representativeVerificationStatus: "VERIFIED",
          reviewedByUserId: req.auth!.userId,
          reviewedAt: new Date(),
          reviewReason: req.body.reason,
          lastSuccessfulCheckAt: new Date(),
          expiresAt: new Date(Date.now() + env.BUSINESS_VERIFICATION_RECHECK_DAYS * 86_400_000),
        },
      })
      if (!changed.count) throw new HttpError(409, "This request has already changed")
      await tx.business.update({
        where: { id: current.businessId },
        data: {
          verificationStatus: "VERIFIED",
          verifiedAt: new Date(),
          verificationNotes: req.body.reason,
        },
      })
      await recordEvent(tx, {
        verificationId: current.id,
        actorId: req.auth!.userId,
        action: current.registrationStatus === "REGISTERED" ? "MANUALLY_VERIFIED" : "VERIFIED_WITH_LIMITATIONS",
        fromStatus: current.overallStatus,
        toStatus: finalStatus,
        reason: req.body.reason,
      })
      await notifyOwner(tx, {
        userId: current.submittedByUserId,
        email: current.submittedBy.email,
        name: current.submittedBy.name,
        businessName: current.business.name,
        status: finalStatus,
        reason: req.body.reason,
      })
      await tx.auditLog.create({
        data: { actorId: req.auth!.userId, action: "business_verification_manually_verified", target: current.providerReference },
      })
      return tx.businessVerification.findUniqueOrThrow({ where: { id: current.id }, include: caseInclude })
    })
    res.json({ data: dto(updated) })
  }),
)

businessVerificationAdminRoutes.post(
  "/:id/reject",
  validateBody(reasonSchema),
  asyncHandler(async (req, res) => {
    const current = await prisma.businessVerification.findUnique({
      where: { id: req.params.id },
      include: { business: true, submittedBy: true },
    })
    if (!current) throw new HttpError(404, "Verification request not found")
    if (current.submittedByUserId === req.auth!.userId) throw new HttpError(403, "You cannot reject your own verification request")
    if (!mayBeReviewed(current.overallStatus) && current.overallStatus !== "ADDITIONAL_INFORMATION_REQUIRED") {
      throw new HttpError(409, "This request cannot be rejected")
    }
    assertVerificationEmailConfigured()
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.businessVerification.updateMany({
        where: { id: current.id, overallStatus: current.overallStatus },
        data: {
          overallStatus: "REJECTED",
          businessVerificationStatus: "FAILED",
          representativeVerificationStatus: "FAILED",
          reviewedByUserId: req.auth!.userId,
          reviewedAt: new Date(),
          reviewReason: req.body.reason,
        },
      })
      if (!changed.count) throw new HttpError(409, "This request has already changed")
      await tx.business.update({ where: { id: current.businessId }, data: { verificationStatus: "REJECTED", verifiedAt: null, verificationNotes: req.body.reason } })
      await tx.businessShare.updateMany({
        where: { businessId: current.businessId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      await recordEvent(tx, {
        verificationId: current.id,
        actorId: req.auth!.userId,
        action: "REJECTED",
        fromStatus: current.overallStatus,
        toStatus: "REJECTED",
        reason: req.body.reason,
      })
      await notifyOwner(tx, {
        userId: current.submittedByUserId,
        email: current.submittedBy.email,
        name: current.submittedBy.name,
        businessName: current.business.name,
        status: "REJECTED",
        reason: req.body.reason,
      })
      await tx.auditLog.create({
        data: { actorId: req.auth!.userId, action: "business_verification_rejected", target: current.providerReference },
      })
      return tx.businessVerification.findUniqueOrThrow({ where: { id: current.id }, include: caseInclude })
    })
    res.json({ data: dto(updated) })
  }),
)
