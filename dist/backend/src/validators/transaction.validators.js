import { z } from "zod";
export const createTransactionSchema = z.object({
    type: z.enum(["INCOME", "EXPENSE"]),
    description: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(60),
    amount: z.number().positive().max(100_000_000),
    date: z.string().date().optional(),
});
