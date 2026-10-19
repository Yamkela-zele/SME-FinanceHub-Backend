export const rand = (cents) => cents / 100;
export const toCents = (amount) => Math.round(amount * 100);
export const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
export const monthLabel = (d) => d.toLocaleString("en-ZA", { month: "short", timeZone: "UTC" });
export const monthStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
