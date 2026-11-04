import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db";
import * as schema from "./db/schema";

if (typeof window !== "undefined") {
  throw new Error("This authentication module can only be executed on the server.");
}

export const USER_ROLES = {
  DOCUMENTATION_EXECUTIVE: "DOCUMENTATION_EXECUTIVE",
  DOCUMENTATION_MANAGER: "DOCUMENTATION_MANAGER",
} as const;

export type UserRole = (typeof USER_ROLES)[keyof typeof USER_ROLES];

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: true,
        defaultValue: USER_ROLES.DOCUMENTATION_EXECUTIVE,
        input: false,
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
