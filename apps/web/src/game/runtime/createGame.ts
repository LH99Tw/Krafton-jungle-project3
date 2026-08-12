import * as Phaser from "phaser";
import type { GameStartOptions } from "../domain/types";
import { RoomGameScene } from "./room/RoomGameScene";

export function createGame(parent: HTMLElement, options: GameStartOptions): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: 1280,
    height: 720,
    // Keep the hand-off from the launch curtain fully black until the first
    // world frame is rendered; the previous blue-green clear color flashed
    // while Phaser initialized.
    backgroundColor: "#000000",
    pixelArt: true,
    antialias: false,
    physics: {
      default: "arcade",
      arcade: {
        gravity: { x: 0, y: 0 },
        debug: false,
      },
    },
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: {
      roundPixels: true,
      powerPreference: "high-performance",
    },
    scene: [new RoomGameScene(options)],
  });
}
