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

test("runtime uses procedural hero geometry instead of removed 8-direction bitmap sheets", () => {
  const scene = readFileSync(new URL("../src/game/runtime/room/RoomGameScene.ts", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../src/game/runtime/room/RoomRenderer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(scene, /hero-\$\{classId\}-8dir/);
  assert.match(renderer, /`hero-\$\{classId\}`/);
  assert.match(renderer, /octant \* Math\.PI \/ 4/);
});
