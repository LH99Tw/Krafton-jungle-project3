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
  assert.match(renderer, /setFrame\(heroFrameForPose\(facing, moving, time\)\)/);
  assert.doesNotMatch(generatedTextures, /key: "hero-/);
});

test("network enemy hp bars follow the same interpolated position as their sprites", () => {
  const scene = readFileSync(new URL("../src/game/runtime/room/RoomGameScene.ts", import.meta.url), "utf8");
  const transformUpdate = scene.slice(
    scene.indexOf("  private updateNetworkTransforms(): void"),
    scene.indexOf("  private configureInput(): void"),
  );
  assert.match(transformUpdate, /sprite\.setPosition\(point\.x, point\.y\)/);
  assert.match(transformUpdate, /networkEnemyHpBars\.get\(enemy\.id\)[\s\S]*?\.setPosition\(point\.x, point\.y\)/);
  assert.match(scene, /graphics\.clear\(\)\.setPosition\(x, y\)/);
  assert.match(scene, /const barX = -width \/ 2/);
});
