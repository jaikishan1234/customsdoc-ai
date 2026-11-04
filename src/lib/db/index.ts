import "server-only";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

if (typeof window !== "undefined") {
  throw new Error("This database connection module can only be executed on the server.");
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Please ensure the DATABASE_URL environment variable is configured."
  );
}

const client = neon(databaseUrl);

export const db = drizzle({ client, schema });
export type Database = typeof db;
