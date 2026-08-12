import { cloneEditorMap, normalizeEditorMapDefinition, type EditorMapDefinition } from "./mapEditor";

export const EDITOR_MAP_LIBRARY_STORAGE_KEY = "five-days:local-map-library:v1";

export type StoredEditorMap = {
  id: string;
  map: EditorMapDefinition;
  createdAt: number;
  updatedAt: number;
};

export type EditorMapLibrary = {
  version: 1;
  activeMapId: string;
  maps: StoredEditorMap[];
};

export function createStoredEditorMap(
  id: string,
  map: EditorMapDefinition,
  now = Date.now(),
): StoredEditorMap {
  return { id, map: cloneEditorMap(map), createdAt: now, updatedAt: now };
}

export function upsertStoredEditorMap(
  maps: readonly StoredEditorMap[],
  id: string,
  map: EditorMapDefinition,
  now = Date.now(),
): StoredEditorMap[] {
  const existing = maps.find((candidate) => candidate.id === id);
  const record: StoredEditorMap = existing
    ? { ...existing, map: cloneEditorMap(map), updatedAt: now }
    : createStoredEditorMap(id, map, now);
  return [record, ...maps.filter((candidate) => candidate.id !== id)];
}

export function deleteStoredEditorMap(
  maps: readonly StoredEditorMap[],
  id: string,
): StoredEditorMap[] {
  return maps.filter((candidate) => candidate.id !== id);
}

export function parseEditorMapLibrary(value: string | null): EditorMapLibrary | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<EditorMapLibrary>;
    if (parsed.version !== 1 || typeof parsed.activeMapId !== "string" || !Array.isArray(parsed.maps)) return null;
    const maps = parsed.maps.flatMap(normalizeStoredEditorMap);
    if (maps.length === 0) return null;
    const activeMapId = maps.some((record) => record.id === parsed.activeMapId)
      ? parsed.activeMapId
      : maps[0]!.id;
    return { version: 1, activeMapId, maps };
  } catch {
    return null;
  }
}

function normalizeStoredEditorMap(value: unknown): StoredEditorMap[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Partial<StoredEditorMap>;
  const map = normalizeEditorMapDefinition(record.map);
  if (!(typeof record.id === "string"
    && record.id.length > 0
    && Number.isFinite(record.createdAt)
    && Number.isFinite(record.updatedAt)
    && map)) return [];
  return [{ ...record, id: record.id, createdAt: record.createdAt!, updatedAt: record.updatedAt!, map }];
}
