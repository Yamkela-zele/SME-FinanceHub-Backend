import { beforeAll, describe, expect, it } from "vitest";
let verifyEvidenceFile;
beforeAll(async () => {
    process.env.DATABASE_URL ??= "mysql://financehub:local-placeholder@localhost:3306/financehub";
    process.env.JWT_SECRET ??= "unit-test-secret-with-more-than-16-characters";
    ({ verifyEvidenceFile } = await import("./verificationEvidence.service.js"));
});
describe("private verification evidence validation", () => {
    it("accepts a signature-valid PDF", () => {
        expect(() => verifyEvidenceFile({
            size: 5,
            mimetype: "application/pdf",
            buffer: Buffer.from("%PDF-"),
        })).not.toThrow();
    });
    it("rejects a mismatched file signature and unsupported type", () => {
        expect(() => verifyEvidenceFile({
            size: 5,
            mimetype: "application/pdf",
            buffer: Buffer.from("hello"),
        })).toThrow("Upload a valid PDF, PNG or JPEG file");
        expect(() => verifyEvidenceFile({
            size: 4,
            mimetype: "text/plain",
            buffer: Buffer.from("text"),
        })).toThrow("Upload a valid PDF, PNG or JPEG file");
    });
    it("enforces the maximum evidence size", () => {
        expect(() => verifyEvidenceFile({
            size: 10 * 1024 * 1024 + 1,
            mimetype: "application/pdf",
            buffer: Buffer.from("%PDF-"),
        })).toThrow("Evidence files must be no larger than 10 MB");
    });
});
