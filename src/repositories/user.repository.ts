import { prisma } from "../config/db.js"

export const userRepository = {
  findByEmail: (email: string) => prisma.user.findUnique({ where: { email: email.toLowerCase() } }),
  findById: (id: string) => prisma.user.findUnique({ where: { id }, include: { business: true } }),
}
