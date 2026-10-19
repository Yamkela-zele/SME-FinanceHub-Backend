import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../config/db.js";
import { isStrongPassword } from "../utils/secureToken.js";
const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!email || !name || !password) {
    throw new Error("Set BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME, and BOOTSTRAP_ADMIN_PASSWORD to create the initial administrator.");
}
if (!isStrongPassword(password)) {
    throw new Error("The initial administrator password must be 12+ characters and include uppercase, lowercase, number, and symbol characters.");
}
try {
    const existingAdmins = await prisma.user.count({ where: { role: "SYSTEM_ADMIN" } });
    if (existingAdmins)
        throw new Error("A system administrator already exists; bootstrap is only available once.");
    if (await prisma.user.findUnique({ where: { email } })) {
        throw new Error("That email address already belongs to an account.");
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
            data: {
                email,
                name,
                passwordHash,
                role: "SYSTEM_ADMIN",
                status: "ACTIVE",
                emailVerifiedAt: new Date(),
                activatedAt: new Date(),
                passwordChangedAt: new Date(),
            },
        });
        await tx.auditLog.create({
            data: { actorId: created.id, action: "initial_system_admin_created" },
        });
        return created;
    });
    console.log(`Created initial administrator account: ${user.email}`);
}
finally {
    await prisma.$disconnect();
}
