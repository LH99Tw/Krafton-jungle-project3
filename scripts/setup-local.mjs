import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve(process.cwd(), ".env.local");
if (existsSync(target)) {
  console.log(".env.local already exists; nothing changed.");
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const values = [
  "NODE_ENV=development",
  "APP_ORIGIN=http://localhost:3000",
  "GAME_SERVER_PUBLIC_URL=ws://localhost:2567",
  "DATABASE_URL=postgresql://five_days:five_days_local@localhost:55432/five_days",
  "DATABASE_SSL=false",
  "DB_POOL_MAX=10",
  "DEV_AUTH_BYPASS=true",
  `AUTH_SESSION_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
  `GUESTBOOK_ADMIN_DELETE_KEY=${randomBytes(48).toString("base64url")}`,
  `GAME_TICKET_PRIVATE_KEY_BASE64=${Buffer.from(privateKey).toString("base64")}`,
  `GAME_TICKET_PUBLIC_KEY_BASE64=${Buffer.from(publicKey).toString("base64")}`,
  "GAME_TICKET_ACTIVE_KID=local-v1",
  "PROTOCOL_VERSION=6",
  "MAX_LIVE_INVADERS=256",
  "ALLOWED_ORIGINS=http://localhost:3000",
  "SERVER_VERSION=development",
  "",
].join("\n");

await writeFile(target, values, { mode: 0o600, flag: "wx" });
console.log("Created .env.local with local-only PostgreSQL, auth, and JWT settings.");
