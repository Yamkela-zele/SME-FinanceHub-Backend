import { Router } from "express"
import { prisma } from "../../config/db.js"
import { requireAuth } from "../../middleware/auth.js"
import { asyncHandler } from "../../utils/asyncHandler.js"
import { HttpError } from "../../utils/httpError.js"

export const notificationsRoutes = Router()
notificationsRoutes.use(requireAuth)

notificationsRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await prisma.notification.findMany({
      where: { userId: req.auth!.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    })
    res.json({
      data: rows.map((notification) => ({
        id: notification.id,
        title: notification.title,
        meta: notification.message,
        to: notification.link ?? "/app/dashboard",
        urgent: notification.urgent,
        readAt: notification.readAt?.toISOString() ?? null,
        createdAt: notification.createdAt.toISOString(),
      })),
    })
  }),
)

notificationsRoutes.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const result = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.auth!.userId, readAt: null },
      data: { readAt: new Date() },
    })
    if (!result.count) {
      const exists = await prisma.notification.findFirst({
        where: { id: req.params.id, userId: req.auth!.userId },
        select: { id: true },
      })
      if (!exists) throw new HttpError(404, "Notification not found")
    }
    res.json({ ok: true })
  }),
)

notificationsRoutes.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    const result = await prisma.notification.updateMany({
      where: { userId: req.auth!.userId, readAt: null },
      data: { readAt: new Date() },
    })
    res.json({ updated: result.count })
  }),
)
