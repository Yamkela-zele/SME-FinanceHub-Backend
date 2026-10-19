import { createRequire } from "node:module"
import { defineConfig } from "vitest/config"

const require = createRequire(import.meta.url)

export default defineConfig({
  resolve: { alias: { supertest: require.resolve("supertest") } },
  test: { include: ["../frontend/tests/**/*.test.ts", "src/**/*.test.ts"] },
})
