import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OFFICIAL_MAP_COMPILER_VERSION,
  officialMapRevisionPayload,
} from "@five-days/game-core";
import { isEditorMapDefinition, validateEditorMap, type EditorMapDefinition } from "../src/game/domain/mapEditor";
import { buildEditorCoreWorld } from "../src/features/map-editor/editorCoreWorld";

const packageDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryDirectory = path.resolve(packageDirectory, "../..");
const sourcePath = path.join(repositoryDirectory, "packages/game-core/src/v02/official-map.source.json");
const generatedPath = path.join(repositoryDirectory, "packages/game-core/src/v02/official-map.generated.json");
const argumentsList = process.argv.slice(2);
const check = argumentsList.includes("--check");
const inputIndex = argumentsList.indexOf("--input");
const inputPath = inputIndex >= 0 ? argumentsList[inputIndex + 1] : undefined;

if (inputIndex >= 0 && !inputPath) throw new Error("--input 뒤에 편집기에서 내보낸 JSON 경로를 지정해 주세요.");

const inputJson = JSON.parse(await readFile(inputPath ? path.resolve(inputPath) : sourcePath, "utf8")) as unknown;
const mapCandidate = extractMap(inputJson);
if (!isEditorMapDefinition(mapCandidate)) throw new Error("공식 맵 입력의 필드 형식이나 방 크기가 올바르지 않습니다.");
const failures = validateEditorMap(mapCandidate);
if (failures.length > 0) throw new Error(failures.join(" "));

const map = mapCandidate as EditorMapDefinition;
const world = { ...buildEditorCoreWorld(map), id: "official-map" };
const mapRevision = crypto.createHash("sha256")
  .update(JSON.stringify(officialMapRevisionPayload(map, world)))
  .digest("hex");
const manifest = {
  schemaVersion: 1,
  compilerVersion: OFFICIAL_MAP_COMPILER_VERSION,
  mapRevision,
  map,
  world,
};
const output = `${JSON.stringify(manifest, null, 2)}\n`;

if (check) {
  const current = (await readFile(generatedPath, "utf8")).replace(/\r\n/g, "\n");
  assert.equal(current, output, "공식 맵 생성물이 최신이 아닙니다. pnpm map:generate를 실행해 주세요.");
} else {
  if (inputPath) await writeFile(sourcePath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  await writeFile(generatedPath, output, "utf8");
}

console.log(`${check ? "verified" : "generated"}: ${path.relative(repositoryDirectory, generatedPath)} (${mapRevision})`);

function extractMap(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const candidate = value as { map?: unknown };
  return candidate.map ?? value;
}
