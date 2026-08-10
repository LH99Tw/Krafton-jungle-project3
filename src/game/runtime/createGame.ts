import * as Phaser from "phaser";
import type { GameStartOptions } from "../domain/types";
import { GameScene } from "./GameScene";

export function createGame(parent: HTMLElement, options: GameStartOptions): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: 1280,
    height: 720,
    backgroundColor: "#11171a",
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
    scene: [new GameScene(options)],
  });
}
