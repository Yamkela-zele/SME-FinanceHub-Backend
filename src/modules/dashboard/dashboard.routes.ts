import { Router } from "express"
import { prisma } from "../../config/db.js"
import { requireAuth, requireRole } from "../../middleware/auth.js"
import { asyncHandler } from "../../utils/asyncHandler.js"
import { addMonths, monthKey, monthLabel, monthStart, rand } from "../../utils/format.js"
import { businessIdFor } from "../../utils/ownerBusiness.js"

export const dashboardRoutes = Router()
dashboardRoutes.use(requireAuth, requireRole("owner"))

const pct = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10)

dashboardRoutes.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const businessId = await businessIdFor(req.auth!.userId)
    const [txs, invoices, business] = await Promise.all([
      prisma.transaction.findMany({ where: { businessId } }),
      prisma.invoice.findMany({ where: { businessId } }),
      prisma.business.findUnique({ where: { id: businessId } }),
    ])

    const latest = txs.reduce<Date | null>((m, t) => (!m || t.date > m ? t.date : m), null)
    const anchor = monthStart(latest ?? new Date())
    const buckets = new Map<string, { income: number; expenses: number }>()
    for (const t of txs) {
      const k = monthKey(t.date)
      const b = buckets.get(k) ?? { income: 0, expenses: 0 }
      if (t.type === "INCOME") b.income += t.amountCents
      else b.expenses += t.amountCents
      buckets.set(k, b)
    }
    const series = Array.from({ length: 6 }, (_, i) => {
      const d = addMonths(anchor, i - 5)
      const b = buckets.get(monthKey(d)) ?? { income: 0, expenses: 0 }
      return { month: monthLabel(d), income: rand(b.income), expenses: rand(b.expenses) }
    })
    const cur = series[5]
    const prev = series[4]

    const open = invoices.filter((i) => ["SENT", "PARTIALLY_PAID", "OVERDUE"].includes(i.status))
    const overdue = open.filter((i) => i.status === "OVERDUE")
    const sum = (list: typeof open) => list.reduce((s, i) => s + i.totalCents - i.paidCents, 0)

    const net = txs.reduce((s, t) => s + (t.type === "INCOME" ? t.amountCents : -t.amountCents), 0)
    const last3 = series.slice(3).reduce((s, m) => s + m.expenses, 0) / 3

    res.json({
      businessName: business?.name,
      period: anchor.toLocaleString("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" }),
      series,
      kpis: {
        income: { value: cur.income, change: pct(cur.income, prev.income) },
        expenses: { value: cur.expenses, change: pct(cur.expenses, prev.expenses) },
        net: { value: cur.income - cur.expenses, change: pct(cur.income - cur.expenses, prev.income - prev.expenses) },
        outstanding: { value: rand(sum(open)), count: open.length, overdueValue: rand(sum(overdue)), overdueCount: overdue.length },
      },
      cash: {
        opening: rand(net),
        inflows: rand(sum(open)),
        outflows: Math.round(last3),
        projected: Math.round(rand(net) + rand(sum(open)) - last3),
      },
      attention: {
        overdueInvoices: overdue.length,
        overdueValue: rand(sum(overdue)),
        needReview: txs.filter((t) => !t.reviewed).length,
      },
    })
  }),
)
