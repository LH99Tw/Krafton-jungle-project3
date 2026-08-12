import officialMapManifestJson from "./official-map.generated.json";
import type { CoreWorldDefinition } from "./simulation";

export const OFFICIAL_MAP_COMPILER_VERSION = 2;

export type AuthoredRoomType = "start" | "empty" | "resource" | "static-monster" | "hidden-monster" | "gate" | "boss"
  | "gate-candidate" | "shop" | "shrine" | "trap" | "checkpoint" | "gamble" | "altar" | "gold";
export type AuthoredAssetTheme = "forest" | "marsh" | "wastes";
export type AuthoredPortSide = "north" | "east" | "south" | "west";
export type AuthoredConnectionPort = Readonly<{ side: AuthoredPortSide; offset: number }>;
export type AuthoredMapDefinition = Readonly<{
  version: 1;
  title: string;
  rooms: readonly Readonly<{
    id: string;
    name: string;
    type: AuthoredRoomType;
    asset: AuthoredAssetTheme;
    x: number;
    y: number;
    width: number;
    height: number;
  }>[];
  connections: readonly Readonly<{
    id: string;
    from: string;
    to: string;
    fromPort?: AuthoredConnectionPort;
    toPort?: AuthoredConnectionPort;
    width?: number;
  }>[];
}>;

export type OfficialMapManifest = Readonly<{
  schemaVersion: 1;
  compilerVersion: typeof OFFICIAL_MAP_COMPILER_VERSION;
  mapRevision: string;
  map: AuthoredMapDefinition;
  /** Generated authoritative world; game-server never imports editor UI code. */
  world: CoreWorldDefinition;
}>;

export function officialMapRevisionPayload(
  map: AuthoredMapDefinition,
  world: CoreWorldDefinition,
): Readonly<{ compilerVersion: number; map: AuthoredMapDefinition; world: CoreWorldDefinition }> {
  return { compilerVersion: OFFICIAL_MAP_COMPILER_VERSION, map, world };
}

export const OFFICIAL_MAP_MANIFEST = officialMapManifestJson as unknown as OfficialMapManifest;
export const OFFICIAL_WORLD = OFFICIAL_MAP_MANIFEST.world;
