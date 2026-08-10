import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

type Db = NodePgDatabase<typeof schema>;

const globalDatabase = globalThis as typeof globalThis & {
  fiveDaysPool?: Pool;
  fiveDaysDb?: Db;
};

export function getPool(): Pool {
  if (globalDatabase.fiveDaysPool) return globalDatabase.fiveDaysPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  globalDatabase.fiveDaysPool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });
  return globalDatabase.fiveDaysPool;
}

export function getDb(): Db {
  if (!globalDatabase.fiveDaysDb) {
    globalDatabase.fiveDaysDb = drizzle({ client: getPool(), schema });
  }
  return globalDatabase.fiveDaysDb;
}

export async function checkDatabase(): Promise<void> {
  await getPool().query("select 1");
}

export { schema };
