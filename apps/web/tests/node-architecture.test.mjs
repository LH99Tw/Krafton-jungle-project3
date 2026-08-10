import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("uses the standard Next.js Node runtime", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(packageJson.scripts.dev, "next dev");
  assert.equal(packageJson.scripts.start, "next start");
  assert.ok(packageJson.dependencies.next);
  assert.equal(packageJson.dependencies.vinext, undefined);
  assert.equal(packageJson.devDependencies?.["@cloudflare/vite-plugin"], undefined);

  await assert.rejects(access(new URL("worker/index.ts", root)));
  await assert.rejects(access(new URL("vite.config.ts", root)));
  await assert.rejects(access(new URL(".openai/hosting.json", root)));
});

test("exposes server session, game ticket, health, and read-only run endpoints", async () => {
  const required = [
    "app/api/auth/login/route.ts",
    "app/api/auth/callback/route.ts",
    "app/api/auth/logout/route.ts",
    "app/api/session/route.ts",
    "app/api/game-ticket/route.ts",
    "app/api/health/live/route.ts",
    "app/api/health/ready/route.ts",
    "app/api/guestbook/route.ts",
    "app/api/runs/route.ts",
  ];
  await Promise.all(required.map((file) => access(new URL(file, root))));
  const runs = await readFile(new URL("app/api/runs/route.ts", root), "utf8");
  assert.match(runs, /SERVER_AUTHORITY_REQUIRED/);
});

test("retains the Phaser game while adding the Colyseus transport", async () => {
  const required = [
    "src/game/runtime/GameScene.ts",
    "src/game/transport/ColyseusTransport.ts",
    "src/features/game/GameShell.tsx",
  ];
  await Promise.all(required.map((file) => access(new URL(file, root))));
  const transport = await readFile(new URL("src/game/transport/ColyseusTransport.ts", root), "utf8");
  assert.match(transport, /joinOrCreate\(PARTY_ROOM/);
  assert.match(transport, /POST/);
  assert.match(transport, /game-ticket/);
});
