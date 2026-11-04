import { defineConfig } from "drizzle-kit";

// Load .env.local for Drizzle Kit CLI executions outside the Next.js runtime
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Environment variables may be injected by the runtime environment or CI
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Please configure DATABASE_URL in .env.local or the runtime environment."
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
