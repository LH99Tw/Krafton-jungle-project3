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
import { createVerticalHexMap } from "./vertical-hex-map";

const packageDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryDirectory = path.resolve(packageDirectory, "../..");
const sourcePath = path.join(repositoryDirectory, "packages/game-core/src/v02/official-map.source.json");
const generatedPath = path.join(repositoryDirectory, "packages/game-core/src/v02/official-map.generated.json");
const argumentsList = process.argv.slice(2);
const check = argumentsList.includes("--check");
const inputIndex = argumentsList.indexOf("--input");
const inputPath = inputIndex >= 0 ? argumentsList[inputIndex + 1] : undefined;

if (inputIndex >= 0 && !inputPath) throw new Error("--input 뒤에 편집기에서 내보낸 JSON 경로를 지정해 주세요.");

const inputJson = inputPath
  ? JSON.parse(await readFile(path.resolve(inputPath), "utf8")) as unknown
  : createVerticalHexMap();
const mapCandidate = extractMap(inputJson);
if (!isEditorMapDefinition(mapCandidate)) throw new Error("공식 맵 입력의 필드 형식이나 방 크기가 올바르지 않습니다.");
const failures = validateEditorMap(mapCandidate);
if (failures.length > 0) throw new Error(failures.join(" "));
validateOfficialHexMap(mapCandidate as EditorMapDefinition);

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
  assert.equal(await readFile(generatedPath, "utf8"), output, "공식 맵 생성물이 최신이 아닙니다. pnpm map:generate를 실행해 주세요.");
} else {
  await writeFile(sourcePath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  await writeFile(generatedPath, output, "utf8");
}

console.log(`${check ? "verified" : "generated"}: ${path.relative(repositoryDirectory, generatedPath)} (${mapRevision})`);

function extractMap(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const candidate = value as { map?: unknown };
  return candidate.map ?? value;
}

function validateOfficialHexMap(map: EditorMapDefinition): void {
  for (const [asset, zone] of [["forest", 1], ["marsh", 2], ["wastes", 3]] as const) {
    assert.equal(map.rooms.filter((room) => room.asset === asset && room.type === "gate-candidate").length, 9, `${zone}구역 게이트 후보는 정확히 9개여야 합니다.`);
    assert.equal(map.rooms.filter((room) => room.asset === asset && room.type === "gold").length, 1, `${zone}구역 골드방은 정확히 1개여야 합니다.`);
  }
  assert.equal(map.rooms.filter((room) => room.type === "checkpoint").length, 3, "구역별 체크포인트가 필요합니다.");
  assert.equal(map.rooms.filter((room) => room.type === "altar").length, 1, "제단은 2구역에 하나만 있어야 합니다.");
}
