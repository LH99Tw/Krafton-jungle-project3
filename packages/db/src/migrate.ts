import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, getPool } from "./index";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

try {
  await migrate(getDb(), { migrationsFolder });
} finally {
  await getPool().end();
}
