import { Router } from "express"
import { z } from "zod"
import { requireAuth, requireRole } from "../../middleware/auth.js"
import { rateLimit } from "../../middleware/rateLimit.js"
import { validateBody } from "../../middleware/validate.js"
import {
  acceptInvitationSchema,
  createPasswordSchema,
  invitationSchema,
  loginSchema,
  registerOwnerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  resendVerificationSchema,
  verifyEmailSchema,
} from "../../validators/auth.validators.js"
import { asyncHandler } from "../../utils/asyncHandler.js"
import { authService } from "./auth.service.js"

export const authRoutes = Router()

authRoutes.post(
  "/login",
  validateBody(loginSchema),
  rateLimit({ windowMs: 60_000, max: 10 }),
  asyncHandler(async (req, res) => res.json(await authService.login(req.body.email, req.body.password))),
)

authRoutes.post(
  "/register-owner",
  rateLimit({ windowMs: 60 * 60_000, max: 5 }),
  validateBody(registerOwnerSchema),
  asyncHandler(async (req, res) => res.status(202).json(await authService.registerOwner(req.body))),
)

authRoutes.post(
  "/verify-email",
  rateLimit({ windowMs: 60_000, max: 20 }),
  validateBody(verifyEmailSchema),
  asyncHandler(async (req, res) => res.json(await authService.verifyEmail(req.body.token))),
)

authRoutes.post(
  "/create-password",
  rateLimit({ windowMs: 60_000, max: 10 }),
  validateBody(createPasswordSchema),
  asyncHandler(async (req, res) => res.json(await authService.createPassword(req.body.token, req.body.password))),
)

authRoutes.post(
  "/resend-verification",
  rateLimit({ windowMs: 60_000, max: 5 }),
  validateBody(resendVerificationSchema),
  asyncHandler(async (req, res) => res.status(202).json(await authService.resendVerification(req.body.email))),
)

authRoutes.post(
  "/request-password-reset",
  rateLimit({ windowMs: 60_000, max: 5 }),
  validateBody(requestPasswordResetSchema),
  asyncHandler(async (req, res) => res.status(202).json(await authService.requestPasswordReset(req.body.email))),
)

authRoutes.post(
  "/reset-password",
  rateLimit({ windowMs: 60_000, max: 10 }),
  validateBody(resetPasswordSchema),
  asyncHandler(async (req, res) => res.json(await authService.resetPassword(req.body.token, req.body.password))),
)

authRoutes.post(
  "/validate-invitation",
  rateLimit({ windowMs: 60_000, max: 20 }),
  validateBody(invitationSchema),
  asyncHandler(async (req, res) => res.json(await authService.validateInvitation(req.body.token))),
)

authRoutes.post(
  "/accept-invitation",
  rateLimit({ windowMs: 60_000, max: 10 }),
  validateBody(acceptInvitationSchema),
  asyncHandler(async (req, res) => res.json(await authService.acceptInvitation(req.body.token, req.body.password))),
)

authRoutes.post(
  "/resend-invitation",
  requireAuth,
  requireRole("admin"),
  validateBody(z.object({ invitationId: z.string().min(1) }).strict()),
  asyncHandler(async (req, res) => res.status(202).json(await authService.resendInvitation(req.body.invitationId, req.auth!.userId))),
)

authRoutes.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => res.json(await authService.me(req.auth!.userId))),
)

authRoutes.patch(
  "/me",
  requireAuth,
  validateBody(z.object({ name: z.string().trim().min(2).max(80) }).strict()),
  asyncHandler(async (req, res) => res.json(await authService.updateName(req.auth!.userId, req.body.name))),
)
