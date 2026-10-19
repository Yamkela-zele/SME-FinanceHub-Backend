import { prisma } from "../config/db.js";
export const userRepository = {
    findByEmail: (email) => prisma.user.findUnique({ where: { email: email.toLowerCase() } }),
    findById: (id) => prisma.user.findUnique({ where: { id }, include: { business: true } }),
};
