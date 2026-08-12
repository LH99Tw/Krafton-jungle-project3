import type { GameStartOptions } from "./types";

export function resolveServerRuntimeOptions(options: GameStartOptions): GameStartOptions {
  return { ...options, runtimeMode: "server" };
}
