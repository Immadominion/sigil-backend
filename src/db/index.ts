import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";
import path from "path";
import { fileURLToPath } from "url";

const client = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(client, { schema });

export type Database = typeof db;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
  console.log("Running database migrations...");
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
  console.log("Migrations complete.");
}
