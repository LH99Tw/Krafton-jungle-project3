import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the first room render happens after renderer and textures are initialized", () => {
  const source = readFileSync(new URL("../src/game/runtime/room/RoomGameScene.ts", import.meta.url), "utf8");
  const createBody = source.slice(source.indexOf("  create(): void {"), source.indexOf("  private configureCamera"));
  const rendererCreation = createBody.indexOf("this.roomRenderer = new RoomRenderer(this)");
  const textureCreation = createBody.indexOf("this.roomRenderer.create()");
  const initialRender = createBody.indexOf("this.roomRenderer.renderWorld(this.zoneWorld");
  assert.ok(rendererCreation >= 0);
  assert.ok(textureCreation > rendererCreation);
  assert.ok(initialRender > textureCreation, "room and corridor textures must render only after their frames exist");
});

test("runtime preloads four-direction hero sheets and selects a movement-facing frame", () => {
  const scene = readFileSync(new URL("../src/game/runtime/room/RoomGameScene.ts", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../src/game/runtime/room/RoomRenderer.ts", import.meta.url), "utf8");
  const generatedTextures = readFileSync(new URL("../src/game/client/render/createTextures.ts", import.meta.url), "utf8");
  assert.match(scene, /this\.load\.spritesheet\(`hero-\$\{classId\}`/);
  assert.match(scene, /frameWidth: HERO_SPRITE_FRAME_SIZE/);
  assert.match(scene, /endFrame: HERO_TOTAL_FRAME_COUNT - 1/);
  assert.match(renderer, /`hero-\$\{classId\}`/);
  assert.match(renderer, /heroFacingForMovement\(previous, movementX, movementY\)/);
  assert.match(renderer, /if \(moving && !wasMoving\) hero\.setData\("heroWalkStartedAt", time\)/);
  assert.match(renderer, /setFrame\(heroFrameForPose\(facing, moving, animationElapsedMs\)\)/);
  assert.doesNotMatch(generatedTextures, /key: "hero-/);
});

test("network enemy hp bars are batched at the interpolated sprite positions", () => {
  const scene = readFileSync(new URL("../src/game/runtime/room/RoomGameScene.ts", import.meta.url), "utf8");
  const transformUpdate = scene.slice(
    scene.indexOf("  private updateNetworkTransforms(): void"),
    scene.indexOf("  private configureInput(): void"),
  );
  assert.match(transformUpdate, /sprite\.setPosition\(point\.x, point\.y\)/);
  assert.match(transformUpdate, /this\.drawNetworkEnemyHpBars\(snapshot, localState, now\)/);
  assert.match(scene, /const barX = sprite\.x - width \/ 2/);
  assert.doesNotMatch(scene, /networkEnemyHpBars/);
});

test("network enemies use a bounded render queue without client physics bodies", () => {
  const scene = readFileSync(new URL("../src/game/runtime/room/RoomGameScene.ts", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../src/game/runtime/room/RoomRenderer.ts", import.meta.url), "utf8");
  assert.match(scene, /NETWORK_ENEMY_SPAWN_BUDGET_MS = 3/);
  assert.match(scene, /NETWORK_ENEMY_SPAWN_LIMIT = 12/);
  assert.match(scene, /materializePendingNetworkEnemies\(\)/);
  assert.match(scene, /new Set\(enemies\.filter\(\(enemy\) => enemy\.alive\)\.map\(\(enemy\) => enemy\.id\)\)/);
  assert.match(scene, /releaseNetworkEnemy\(this\.networkEnemyKinds\.get\(id\) \?\? "static", sprite\)/);
  assert.match(renderer, /acquireNetworkEnemy[\s\S]*?this\.scene\.add\.sprite/);
  assert.doesNotMatch(renderer, /acquireNetworkEnemy[\s\S]*?physics\.add\.sprite/);
});

test("new enemies emerge from a client-rendered black floor shadow", () => {
  const renderer = readFileSync(new URL("../src/game/runtime/room/RoomRenderer.ts", import.meta.url), "utf8");
  assert.match(renderer, /playEnemyEmergence/);
  assert.match(renderer, /setTint\(0x050505\)/);
  assert.match(renderer, /setCrop\(0, frameHeight - revealedHeight, frameWidth, revealedHeight\)/);
  assert.match(renderer, /add\.ellipse[\s\S]*?0x000000/);
  assert.match(renderer, /if \(kind === "hidden"\) this\.applyDemonHoverMotion\(enemy\)/);
});

test("room transitions update dynamic waypoints without rebuilding the authored world", () => {
  const scene = readFileSync(new URL("../src/game/runtime/room/RoomGameScene.ts", import.meta.url), "utf8");
  const networkRender = scene.slice(
    scene.indexOf("  private renderNetworkRoom("),
    scene.indexOf("  private activeWaypointRooms("),
  );
  assert.match(networkRender, /updateWaypoints\(this\.zoneWorld, waypointRooms\)/);
  assert.doesNotMatch(networkRender, /renderZoneWorld|renderWorld/);
});

test("the server ready signal waits for Phaser renderer readiness", () => {
  const transport = readFileSync(new URL("../src/game/transport/ColyseusTransport.ts", import.meta.url), "utf8");
  const connectBody = transport.slice(transport.indexOf("  async connect("), transport.indexOf("  subscribe("));
  assert.match(connectBody, /this\.flushRoomReady\(\)/);
  assert.doesNotMatch(connectBody, /this\.send\("room\.ready"/);
  assert.match(transport, /markRendererReady\(\)[\s\S]*?this\.rendererReady = true/);
  assert.match(transport, /if \(!this\.room \|\| !this\.rendererReady \|\| this\.readySent\) return/);
});

test("network basic attacks render from reliable event coordinates after target removal", () => {
  const scene = readFileSync(new URL("../src/game/runtime/room/RoomGameScene.ts", import.meta.url), "utf8");
  const transport = readFileSync(new URL("../src/game/transport/ColyseusTransport.ts", import.meta.url), "utf8");
  assert.match(transport, /room\.onMessage\("combat\.action"/);
  assert.match(transport, /combatActionEventSchema\.safeParse\(message\)/);
  assert.match(scene, /gameBridge\.on\("combatAction", \(action\) => this\.receiveNetworkCombatAction\(action\)\)/);
  assert.match(scene, /action\.targetX,[\s\S]*?action\.targetY/);
  assert.doesNotMatch(
    scene.slice(scene.indexOf("  private renderNetworkCombatAction("), scene.indexOf("  private flushPendingCombatActions(")),
    /snapshot\.enemies|networkEnemies\.get\(action\.targetId\)/,
  );
});
