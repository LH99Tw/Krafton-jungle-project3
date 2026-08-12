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

test("fails closed on auth outages and bounds public mutation requests", async () => {
  const session = await readFile(new URL("app/api/session/route.ts", root), "utf8");
  const guest = await readFile(new URL("app/api/auth/guest/route.ts", root), "utf8");
  const ticket = await readFile(new URL("app/api/game-ticket/route.ts", root), "utf8");
  const guestbook = await readFile(new URL("app/api/guestbook/route.ts", root), "utf8");
  const callback = await readFile(new URL("app/api/auth/callback/route.ts", root), "utf8");
  const instrumentation = await readFile(new URL("instrumentation.ts", root), "utf8");
  const shell = await readFile(new URL("src/features/game/GameShell.tsx", root), "utf8");

  assert.match(session, /SESSION_UNAVAILABLE/);
  assert.match(guest, /PUBLIC_PLAYTEST_ENABLED/);
  assert.match(guest, /readJsonLimited<[^>]+>\(request, 2048\)/);
  assert.doesNotMatch(guest, /export async function GET/);
  assert.match(ticket, /gameTicketRoomSchema/);
  assert.match(ticket, /registerGameTicket/);
  assert.match(guestbook, /guestbook-write-ip/);
  assert.match(guestbook, /guestbook-write-user/);
  assert.match(guestbook, /GUESTBOOK_PER_MINUTE/);
  assert.match(guestbook, /hasAllowedOrigin\(request\)/);
  assert.doesNotMatch(guestbook, /ADMIN_DELETE_KEY\s*=.*admin@/);
  assert.doesNotMatch(guest, /guest-session-marker/);
  assert.doesNotMatch(callback, /member-session-marker/);
  assert.match(instrumentation, /process\.exit\(1\)/);
  assert.doesNotMatch(shell, /setViewer\(\{ userId: "local-guest"/);
});

test("gates deployments on verification and repairs required production settings", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/deploy-lightsail.yml", root), "utf8");
  const configure = await readFile(new URL("../../deploy/aws/configure-server-env.sh", root), "utf8");
  const instrumentation = await readFile(new URL("instrumentation-node.ts", root), "utf8");

  const verification = workflow.indexOf("name: Verify release candidate");
  const imageBuild = workflow.indexOf("name: Build and push web");
  assert.ok(verification >= 0 && imageBuild > verification);
  assert.match(workflow, /pnpm audit --prod --audit-level moderate/);
  assert.match(workflow, /pnpm lint/);
  assert.match(workflow, /pnpm typecheck/);
  assert.match(workflow, /pnpm test/);
  assert.match(workflow, /workflow_run:\s+workflows: \[CI\][\s\S]+branches: \[main\]/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /RELEASE_SHA:.*github\.event\.workflow_run\.head_sha/);
  assert.match(workflow, /ref: \$\{\{ env\.RELEASE_SHA \}\}/);
  assert.match(workflow, /five-days-game-server:\$\{\{ env\.RELEASE_SHA \}\}/);
  assert.match(workflow, /upsert_env \.env\.web GUESTBOOK_ADMIN_DELETE_KEY/);
  assert.match(workflow, /upsert_env \.env\.web PUBLIC_PLAYTEST_ENABLED true/);
  assert.match(workflow, /upsert_env \.env\.web PROTOCOL_VERSION 9/);
  assert.match(workflow, /upsert_env \.env\.game PROTOCOL_VERSION 9/);
  assert.match(configure, /GUESTBOOK_ADMIN_DELETE_KEY/);
  assert.match(instrumentation, /required\("GUESTBOOK_ADMIN_DELETE_KEY"\)/);
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

test("composes the in-game relic HUD from focused components", async () => {
  const hud = await readFile(new URL("src/features/game/GameHud.tsx", root), "utf8");
  const commandBar = await readFile(new URL("src/features/game/hud/PlayerCommandBar.tsx", root), "utf8");
  const phase = await readFile(new URL("src/features/game/hud/PhaseHud.tsx", root), "utf8");
  const exploration = await readFile(new URL("src/features/game/hud/ExplorationHud.tsx", root), "utf8");
  const minimap = await readFile(new URL("src/features/game/RoomMiniMap.tsx", root), "utf8");
  const styles = await readFile(new URL("app/globals.css", root), "utf8");

  for (const component of ["PhaseHud", "TeamGoldHud", "ExplorationHud", "PlayerCommandBar", "PartyVitalsHud"]) {
    assert.match(hud, new RegExp(`<${component}`));
  }
  const partyVitals = await readFile(new URL("src/features/game/hud/PartyVitalsHud.tsx", root), "utf8");
  assert.match(partyVitals, /PARTY_SIZE = 3/);
  assert.match(partyVitals, /게이트 파괴/);
  assert.match(exploration, /className="map-tactical-footer"/);
  assert.match(exploration, /베이스 내구도/);
  assert.match(exploration, /마왕방 이동/);
  assert.match(minimap, /웨이포인트 위에서 사용할 수 있습니다/);
  assert.match(minimap, /웨이포인트 이동 중/);
  assert.match(minimap, /onWaypointTravel\?\.\(travelRequest\.sourceId, travelRequest\.destinationId\)/);
  assert.doesNotMatch(exploration, /멀티플레이 건설|build-zone-hint|equipment-strip/);
  assert.doesNotMatch(minimap, /PARTY TRAIL|지나온 길|현재 시야|minimap-status|minimap-zoom-controls/);
  assert.match(minimap, /event\.button !== 1/);
  assert.match(minimap, /setPointerCapture\(event\.pointerId\)/);
  assert.match(minimap, /center\.x - deltaX \/ currentTransform\.scale/);
  assert.match(minimap, /onDoubleClick=\{resetView\}/);
  assert.match(minimap, /className="minimap-reset-view"/);
  assert.match(minimap, /미니맵을 내 위치 중심의 기본 보기로 되돌리기/);
  assert.match(styles, /\/\* Notices sit directly below[\s\S]*?\.hud-message \{[\s\S]*?top:clamp\(108px,9vw,132px\)/);
  assert.match(styles, /\/\* Center the combat-stat ledger[\s\S]*?\.player-stats-panel \{[\s\S]*?padding:76px 34px 48px/);
  assert.doesNotMatch(commandBar, /AUTO|TEAM POWER|SPACE/);
  assert.match(commandBar, /keyName="Q"/);
  assert.match(commandBar, /keyName="E"/);
  assert.match(commandBar, /개인 전투 스탯/);
  assert.match(phase, /phase-day\.png/);
  assert.match(phase, /phase-night\.png/);
  const generatedHudAssets = [
    "phase-day.png", "phase-night.png", "gold-coin.png", "frame-phase.png", "frame-gold.png", "frame-map.png",
    "frame-command.png", "frame-stats.png", "skills/swordsman-q.png", "skills/swordsman-e.png",
    "skills/archer-q.png", "skills/archer-e.png", "skills/mage-q.png", "skills/mage-e.png", "skills/stats.png",
  ];
  await Promise.all(generatedHudAssets.map((file) => access(new URL(`public/images/ui/hud/${file}`, root))));
  assert.match(commandBar, /images\/ui\/hud\/skills\/\$\{heroClass\}-\$\{keyName\.toLowerCase\(\)\}\.png/);
});

test("renders the dedicated access sidebar with the clean decorative asset", async () => {
  const sidebar = await readFile(new URL("src/features/lobby/AccessSidebar.tsx", root), "utf8");
  const accessScreen = await readFile(new URL("src/features/lobby/AccessScreen.tsx", root), "utf8");
  const styles = await readFile(new URL("app/globals.css", root), "utf8");

  assert.match(sidebar, /export function AccessSidebar/);
  assert.match(accessScreen, /<AccessSidebar/);
  assert.doesNotMatch(accessScreen, /className="access-rail"/);
  assert.match(styles, /sidebar-frame-clean\.webp/);
  assert.match(sidebar, /className="access-rail-brand-art"/);
  assert.match(styles, /\.access-rail-brand-art \{[^}]*sidebar-brand-plaque\.webp/s);
  assert.match(styles, /\.access-rail \*,\s*\.access-rail \*::before,\s*\.access-rail \*::after \{ animation:none !important; \}/s);
  await access(new URL("public/images/access/sidebar-brand-plaque.webp", root));
  assert.match(sidebar, /profileBadgeFor\(viewer\.userId\)/);
  assert.match(sidebar, /className="profile-logout"/);
  assert.match(styles, /\.access-profile > \.profile-logout \{[^}]*grid-column:1 \/ -1[^}]*width:100%/s);

  const profileBadges = ["sword.png", "raven.png", "moon.png", "tower.png", "wolf.png", "chalice.png"];
  await Promise.all(profileBadges.map((file) => access(new URL(`public/images/ui/profile-badges/${file}`, root))));
});

test("keeps augment lab and quick mage launch shortcuts development-only", async () => {
  const accessScreen = await readFile(new URL("src/features/lobby/AccessScreen.tsx", root), "utf8");
  const shell = await readFile(new URL("src/features/game/GameShell.tsx", root), "utf8");

  assert.match(accessScreen, /LOCAL_DEVELOPMENT_TOOLS_ENABLED && onOpenLab/);
  assert.match(accessScreen, /LOCAL_DEVELOPMENT_TOOLS_ENABLED && \(\s*<FantasyButton[\s\S]*마법사로 바로 시작하기/);
  assert.match(shell, /LOCAL_DEVELOPMENT_TOOLS_ENABLED && screen === "lab"/);
  assert.match(shell, /onOpenLab=\{LOCAL_DEVELOPMENT_TOOLS_ENABLED \?/);
  assert.match(shell, /const quickPlayMage = LOCAL_DEVELOPMENT_TOOLS_ENABLED/);
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

test("uses a shared global chat with bounded history and bottom-aware scrolling", async () => {
  const shell = await readFile(new URL("src/features/game/GameShell.tsx", root), "utf8");
  const lobby = await readFile(new URL("src/features/lobby/LobbyScreen.tsx", root), "utf8");
  const transport = await readFile(new URL("src/game/transport/GlobalChatTransport.ts", root), "utf8");
  const styles = await readFile(new URL("app/globals.css", root), "utf8");

  assert.match(shell, /globalChatTransport\.connect/);
  assert.match(shell, /slice\(-100\)/);
  assert.match(transport, /joinOrCreate\(GLOBAL_CHAT_ROOM/);
  assert.match(transport, /global\.chat-history/);
  assert.match(lobby, /title="전체 대화"/);
  assert.match(lobby, /scrollHeight - log\.scrollTop - log\.clientHeight < 48/);
  assert.match(styles, /\.chat-line p::before \{[^}]*linear-gradient\(180deg,#050504 0%,#45413a 48%,#050504 100%\)/s);
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
  assert.match(accessSidebar, /minLength=\{2\} maxLength=\{6\} required placeholder="2~6자 이름"/);
  assert.match(await readFile(new URL("app/api/auth/guest/route.ts", root), "utf8"), /displayName\.length > 6/);
  assert.match(accessScreen, /<FantasyButton[\s\S]*원정대 찾기/);
  assert.match(lobby, /FantasySectionHeading/);
  assert.match(lobby, /FantasyFrame/);

  const generatedAssets = ["button-frame.webp", "panel-frame.webp", "section-header.webp", "room-row.webp", "party-slot.webp", "input-frame.webp"];
  await Promise.all(generatedAssets.map((file) => access(new URL(`public/images/ui/fantasy/${file}`, root))));
});

test("keeps the party creation dialog centered above the lobby", async () => {
  const lobby = await readFile(new URL("src/features/lobby/LobbyScreen.tsx", root), "utf8");
  const styles = await readFile(new URL("app/globals.css", root), "utf8");

  assert.match(styles, /\.lobby-screen > \.create-backdrop \{[^}]*position:fixed[^}]*inset:0[^}]*z-index:100/s);
  assert.match(styles, /\.create-dialog > div \.fantasy-button\[type="submit"\] \{[^}]*color:#ead8a7/s);
  assert.match(lobby, /function createRandomExpeditionName/);
  assert.match(lobby, /roomName\.trim\(\) \|\| suggestedRoomName/);
  assert.match(lobby, /placeholder=\{suggestedRoomName\}/);
  assert.match(lobby, /if \(usingSuggestedName\)/);
});

test("reuses generated navigation chrome across lobby and character selection", async () => {
  const characterSelect = await readFile(new URL("src/features/lobby/CharacterSelectScreen.tsx", root), "utf8");
  const gameShell = await readFile(new URL("src/features/game/GameShell.tsx", root), "utf8");
  const gamePreloader = await readFile(new URL("src/game/client/preloadGameClient.ts", root), "utf8");
  const styles = await readFile(new URL("app/globals.css", root), "utf8");
  const navigationAssets = ["top-bar.webp", "bottom-floor.webp", "team-status-strip-v2.png"];

  await Promise.all(navigationAssets.map((file) => access(new URL(`public/images/ui/navigation/${file}`, root))));
  assert.match(styles, /\.operation-bar,\s*\.select-header \{[^}]*top-bar\.webp/s);
  assert.match(styles, /\.select-footer \{[^}]*bottom-floor\.webp/s);
  assert.match(styles, /\.team-picks::after \{[^}]*team-status-strip-v2\.png/s);
  assert.match(styles, /\.team-pick-image > img/);
  assert.match(styles, /\.team-picks \{[^}]*width:calc\(100% - clamp\(32px,5vw,104px\)\)[^}]*height:84px[^}]*gap:0/s);
  assert.match(styles, /\.team-picks > div:nth-child\(2\) \{[^}]*clip-path:polygon\(0 0,100% 0,94% 100%,6% 100%\)/s);
  assert.match(characterSelect, /className="team-pick-image"/);
  assert.match(styles, /\.team-pick-image \{[^}]*height:calc\(100% - 6px\)[^}]*overflow:hidden/s);
  assert.match(styles, /\.team-pick-image > img \{[^}]*width:100%[^}]*height:100%[^}]*object-fit:cover/s);
  assert.match(styles, /\.class-slashes \{[^}]*width:calc\(100% - 40px\)[^}]*gap:12px/s);
  assert.doesNotMatch(characterSelect, /select-loading|FIELD ASSETS|전장 자원 준비 중/);
  assert.doesNotMatch(characterSelect, /출전 직업을 선택하세요|select-ready-count/);
  assert.match(gameShell, /SELECTION_LAUNCH_DELAY_MS = 2_000/);
  assert.match(gameShell, /selectionPreloadReadyRef\.current\) launchSelectedRun\(event\)/);
  assert.match(gameShell, /window\.setTimeout\([\s\S]*SELECTION_LAUNCH_DELAY_MS/);
  assert.match(gamePreloader, /GAMEPLAY_IMAGE_ASSETS\.map\(loadImage\)/);
  assert.match(gamePreloader, /image\.decode\(\)/);

  const gameCanvas = await readFile(new URL("src/game/client/GameCanvas.tsx", root), "utf8");
  assert.doesNotMatch(gameCanvas, /game-loading|원정 준비 중|gameBridge\.on\("loading"/);
});
