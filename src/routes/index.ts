import { Router } from "express"
import { authRoutes } from "../modules/auth/auth.routes.js"
import { transactionsRoutes } from "../modules/transactions/transactions.routes.js"
import { invoicesRoutes } from "../modules/invoices/invoices.routes.js"
import { applicationsRoutes } from "../modules/applications/applications.routes.js"
import { customersRoutes } from "../modules/customers/customers.routes.js"
import { dashboardRoutes } from "../modules/dashboard/dashboard.routes.js"
import { reportsRoutes } from "../modules/reports/reports.routes.js"
import { fundingRoutes } from "../modules/funding/funding.routes.js"
import { businessesRoutes } from "../modules/businesses/businesses.routes.js"
import { adminRoutes } from "../modules/admin/admin.routes.js"
import { notificationsRoutes } from "../modules/notifications/notifications.routes.js"
import { accountantRoutes } from "../modules/onboarding/accountant.routes.js"
import { fundingPartnerRoutes } from "../modules/onboarding/funding-partners.routes.js"
import { businessVerificationAdminRoutes, businessVerificationRoutes } from "../modules/verification/business-verifications.routes.js"

export const routes = Router()

routes.get("/health", (_req, res) => res.json({ status: "ok" }))
routes.use("/auth", authRoutes)
routes.use("/transactions", transactionsRoutes)
routes.use("/invoices", invoicesRoutes)
routes.use("/applications", applicationsRoutes)
routes.use("/customers", customersRoutes)
routes.use("/dashboard", dashboardRoutes)
routes.use("/reports", reportsRoutes)
routes.use("/funding", fundingRoutes)
routes.use("/businesses", businessesRoutes)
routes.use("/admin", adminRoutes)
routes.use("/notifications", notificationsRoutes)
routes.use("/business-verifications", businessVerificationRoutes)
routes.use("/admin/business-verifications", businessVerificationAdminRoutes)
routes.use(accountantRoutes)
routes.use("/admin/funding-partners", fundingPartnerRoutes)
