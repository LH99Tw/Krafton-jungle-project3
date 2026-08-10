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
    "app/api/auth/guest/route.ts",
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
    "src/game/runtime/room/RoomGameScene.ts",
    "src/game/transport/ColyseusTransport.ts",
    "src/features/game/GameShell.tsx",
  ];
  await Promise.all(required.map((file) => access(new URL(file, root))));
  const transport = await readFile(new URL("src/game/transport/ColyseusTransport.ts", root), "utf8");
  assert.match(transport, /joinOrCreate\(PARTY_ROOM/);
  assert.match(transport, /POST/);
  assert.match(transport, /game-ticket/);
});

test("renders the dedicated access sidebar with the clean decorative asset", async () => {
  const sidebar = await readFile(new URL("src/features/lobby/AccessSidebar.tsx", root), "utf8");
  const accessScreen = await readFile(new URL("src/features/lobby/AccessScreen.tsx", root), "utf8");
  const styles = await readFile(new URL("app/globals.css", root), "utf8");

  assert.match(sidebar, /export function AccessSidebar/);
  assert.match(accessScreen, /<AccessSidebar/);
  assert.doesNotMatch(accessScreen, /className="access-rail"/);
  assert.match(styles, /sidebar-frame-clean\.webp/);
});

test("keeps the lobby room list scrollable without shifting the join controls", async () => {
  const lobby = await readFile(new URL("src/features/lobby/LobbyScreen.tsx", root), "utf8");
  const styles = await readFile(new URL("app/globals.css", root), "utf8");

  assert.match(lobby, /className="room-list-scroll"/);
  assert.match(styles, /\.room-column \{[^}]*grid-template-rows:auto minmax\(0,1fr\) auto/s);
  assert.match(styles, /\.room-list-scroll \{[^}]*overflow-y:auto[^}]*scrollbar-gutter:stable/s);
  assert.match(styles, /\.room-join-strip \{[^}]*align-self:end/s);
  assert.match(styles, /lobby-hall\.webp/);
  await access(new URL("public/images/lobby/lobby-hall.webp", root));
});

test("reuses the fantasy controls across access and lobby screens", async () => {
  const button = await readFile(new URL("src/components/ui/FantasyButton.tsx", root), "utf8");
  const accessSidebar = await readFile(new URL("src/features/lobby/AccessSidebar.tsx", root), "utf8");
  const accessScreen = await readFile(new URL("src/features/lobby/AccessScreen.tsx", root), "utf8");
  const lobby = await readFile(new URL("src/features/lobby/LobbyScreen.tsx", root), "utf8");

  assert.match(button, /export function FantasyButton/);
  assert.match(button, /fantasy-button--\$\{variant\}/);
  assert.match(accessSidebar, /<FantasyButton[^>]+google-login/);
  assert.match(accessSidebar, /<FantasyButton[^>]+guest-enter/);
  assert.match(accessScreen, /<FantasyButton[\s\S]*원정대 찾기/);
  assert.match(lobby, /FantasySectionHeading/);
  assert.match(lobby, /FantasyFrame/);

  const generatedAssets = ["button-frame.webp", "panel-frame.webp", "section-header.webp", "room-row.webp", "party-slot.webp", "input-frame.webp"];
  await Promise.all(generatedAssets.map((file) => access(new URL(`public/images/ui/fantasy/${file}`, root))));
});

test("keeps the party creation dialog centered above the lobby", async () => {
  const styles = await readFile(new URL("app/globals.css", root), "utf8");

  assert.match(styles, /\.lobby-screen > \.create-backdrop \{[^}]*position:fixed[^}]*inset:0[^}]*z-index:100/s);
  assert.match(styles, /\.create-dialog > div \.fantasy-button\[type="submit"\] \{[^}]*color:#ead8a7/s);
});
