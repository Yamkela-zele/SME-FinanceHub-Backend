import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { prisma } from "../config/db.js"
import { env } from "../config/env.js"
import { HttpError } from "../utils/httpError.js"

const header = Buffer.from("FHVE1")
const maximumBytes = 10 * 1024 * 1024

function encryptionKey() {
  if (!env.EVIDENCE_ENCRYPTION_KEY) {
    throw new HttpError(503, "Private evidence storage is not configured")
  }
  return Buffer.from(env.EVIDENCE_ENCRYPTION_KEY, "hex")
}

export function verifyEvidenceFile(file: Pick<Express.Multer.File, "size" | "mimetype" | "buffer">) {
  if (file.size < 1 || file.size > maximumBytes) {
    throw new HttpError(400, "Evidence files must be no larger than 10 MB")
  }
  const valid =
    (file.mimetype === "application/pdf" && file.buffer.subarray(0, 5).toString("ascii") === "%PDF-")
    || (file.mimetype === "image/png" && file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    || (file.mimetype === "image/jpeg" && file.buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
  if (!valid) throw new HttpError(400, "Upload a valid PDF, PNG or JPEG file")
}

export async function storeVerificationEvidence(storageKey: string, content: Buffer) {
  const key = encryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(content), cipher.final()])
  const encrypted = Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext])
  const directory = path.resolve(process.cwd(), env.PRIVATE_EVIDENCE_DIR)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(path.join(directory, `${storageKey}.enc`), encrypted, { flag: "wx", mode: 0o600 })
}

export async function readVerificationEvidence(storageKey: string) {
  const key = encryptionKey()
  const directory = path.resolve(process.cwd(), env.PRIVATE_EVIDENCE_DIR)
  const encrypted = await readFile(path.join(directory, `${storageKey}.enc`))
  if (encrypted.length < header.length + 28 || !encrypted.subarray(0, header.length).equals(header)) {
    throw new Error("Stored verification evidence has an invalid encrypted format")
  }
  const ivStart = header.length
  const tagStart = ivStart + 12
  const ciphertextStart = tagStart + 16
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(ivStart, tagStart))
  decipher.setAuthTag(encrypted.subarray(tagStart, ciphertextStart))
  return Buffer.concat([
    decipher.update(encrypted.subarray(ciphertextStart)),
    decipher.final(),
  ])
}

export async function removeVerificationEvidence(storageKey: string) {
  const directory = path.resolve(process.cwd(), env.PRIVATE_EVIDENCE_DIR)
  await unlink(path.join(directory, `${storageKey}.enc`))
}

export async function purgeExpiredVerificationEvidence() {
  const before = new Date(Date.now() - env.VERIFICATION_EVIDENCE_RETENTION_DAYS * 86_400_000)
  const expired = await prisma.businessVerificationEvidence.findMany({
    where: { createdAt: { lt: before } },
    select: { id: true, storageKey: true },
    take: 100,
  })
  for (const item of expired) {
    try {
      await removeVerificationEvidence(item.storageKey)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    await prisma.businessVerificationEvidence.delete({ where: { id: item.id } })
  }
}

export function evidenceDigest(content: Buffer) {
  return createHash("sha256").update(content).digest("hex")
}

export const verificationEvidenceLimits = { fileSize: maximumBytes, files: 1 }
