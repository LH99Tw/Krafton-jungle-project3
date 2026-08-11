import type { GameStartOptions } from "./types";

export function resolveRuntimeOptions(options: GameStartOptions, gameServerUrl: string): GameStartOptions {
  return { ...options, networked: Boolean(gameServerUrl) };
}
