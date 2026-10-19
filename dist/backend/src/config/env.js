import "dotenv/config";
import { z } from "zod";
const optionalEncryptionKey = z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^[a-fA-F0-9]{64}$/).optional());
const schema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(16),
    JWT_EXPIRES_IN: z.string().default("1h"),
    CORS_ORIGIN: z.string().default("http://localhost:8443"),
    FRONTEND_URL: z.string().url().default("http://localhost:8443"),
    BACKEND_URL: z.string().url().default("http://localhost:4000"),
    EMAIL_PROVIDER_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().trim().min(3).default("SME FinanceHub <onboarding@resend.dev>"),
    EMAIL_OUTBOX_ENCRYPTION_KEY: optionalEncryptionKey,
    EVIDENCE_ENCRYPTION_KEY: optionalEncryptionKey,
    PRIVATE_EVIDENCE_DIR: z.string().min(1).default("private-evidence"),
    BUSINESS_VERIFICATION_RECHECK_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
    VERIFICATION_EVIDENCE_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
    INVITATION_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(10080).default(1440),
    EMAIL_VERIFICATION_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
    PASSWORD_SETUP_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
    PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
    OWNER_REGISTRATION_REQUIRES_REVIEW: z.enum(["true", "false"]).transform((value) => value === "true").default("false"),
});
export const env = schema.parse(process.env);
