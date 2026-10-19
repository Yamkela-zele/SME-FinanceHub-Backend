export const rand = (cents: number) => cents / 100
export const toCents = (amount: number) => Math.round(amount * 100)
export const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
export const monthLabel = (d: Date) => d.toLocaleString("en-ZA", { month: "short", timeZone: "UTC" })
export const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
export const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
