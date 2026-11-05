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

// ---------------------------------------------------------------------------
// Fail-fast environment validation (server side only).
// The application must not boot with a weak, missing or malformed auth setup.
// Never log or export these values — they must not reach client bundles.
// ---------------------------------------------------------------------------

const BETTER_AUTH_SECRET_MIN_LENGTH = 32;

const validateSecret = (): string => {
  const secret = process.env.BETTER_AUTH_SECRET;

  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Configure a strong secret (at least " +
        `32 characters) in .env.local or the runtime environment before starting. ` +
        "Generate one with: openssl rand -base64 32",
    );
  }

  if (secret.length < BETTER_AUTH_SECRET_MIN_LENGTH) {
    throw new Error(
      "BETTER_AUTH_SECRET is too weak. It must be at least " +
        `${BETTER_AUTH_SECRET_MIN_LENGTH} characters long.`,
    );
  }

  return secret;
};

const validateBaseURL = (): { url: string; origin: string } => {
  const raw = process.env.BETTER_AUTH_URL;

  if (!raw) {
    throw new Error(
      "BETTER_AUTH_URL is not set. Configure the absolute application origin " +
        "(e.g. http://localhost:3000) in .env.local or the runtime environment.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "BETTER_AUTH_URL must be a valid absolute URL (e.g. http://localhost:3000).",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      "BETTER_AUTH_URL must use the http: or https: protocol.",
    );
  }

  return { url: raw, origin: parsed.origin };
};

const authSecret = validateSecret();
const { url: authBaseURL, origin: authOrigin } = validateBaseURL();

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  secret: authSecret,
  baseURL: authBaseURL,
  // Explicitly trust only the validated application origin. Additional
  // origins (if ever needed) must be listed here — never derived from
  // request headers.
  trustedOrigins: [authOrigin],
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
