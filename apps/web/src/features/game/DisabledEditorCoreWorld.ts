import type { AuthoredRoomId, CoreWorldDefinition } from "@five-days/game-core";
import type { EditorMapDefinition } from "../../game/domain/mapEditor";

export function editorCoreRoomId(roomId: string): AuthoredRoomId {
  return roomId as AuthoredRoomId;
}

export function buildEditorCoreWorld(_map: EditorMapDefinition): CoreWorldDefinition {
  void _map;
  throw new Error("This development-only world adapter is unavailable in production.");
}
