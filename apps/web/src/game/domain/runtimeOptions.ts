import type { GameStartOptions } from "./types";

export function resolveRuntimeOptions(options: GameStartOptions, gameServerUrl: string | null): GameStartOptions {
  return { ...options, networked: Boolean(gameServerUrl) };
}
