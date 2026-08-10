import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the game briefing", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]*lang="ko"/i);
  assert.match(html, /<title>5일 뒤 마왕/);
  assert.match(html, /낮에는 욕심내고/);
  assert.match(html, /신참 용사를 선택하세요/);
  assert.match(html, /원정 시작/);
  assert.match(html, /방명록 메시지/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps game rules modular and starter preview removed", async () => {
  const requiredModules = [
    "../src/game/domain/types.ts",
    "../src/game/content/classes.ts",
    "../src/game/content/upgrades.ts",
    "../src/game/systems/SessionDirector.ts",
    "../src/game/systems/ProgressionModel.ts",
    "../src/game/transport/GameTransport.ts",
    "../src/game/transport/LocalTransport.ts",
    "../src/game/runtime/GameScene.ts",
  ];
  await Promise.all(requiredModules.map((path) => access(new URL(path, import.meta.url))));
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));

  const [balance, session, packageJson] = await Promise.all([
    readFile(new URL("../src/game/content/balance.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/game/systems/SessionDirector.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(balance, /prototype:\s*\{\s*day:\s*60,\s*night:\s*25,\s*standby:\s*5/);
  assert.match(balance, /full:\s*\{\s*day:\s*210,\s*night:\s*75,\s*standby:\s*15/);
  assert.match(session, /this\.day \+= 1/);
  assert.match(packageJson, /"phaser":/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

