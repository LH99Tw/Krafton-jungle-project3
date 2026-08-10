import * as Phaser from "phaser";

type TextureSpec = {
  key: string;
  width: number;
  height: number;
  draw: (graphics: Phaser.GameObjects.Graphics) => void;
};

export function createGameTextures(scene: Phaser.Scene): void {
  const specs: TextureSpec[] = [
    {
      key: "hero-swordsman",
      width: 28,
      height: 32,
      draw: (g) => {
        g.fillStyle(0x3b2d34).fillRect(7, 4, 14, 9);
        g.fillStyle(0xf2c35c).fillRect(5, 13, 18, 15);
        g.fillStyle(0xfff1b2).fillRect(10, 7, 8, 7);
        g.fillStyle(0xeaf2ff).fillRect(22, 7, 3, 21);
        g.fillStyle(0x5f7ea7).fillRect(3, 28, 8, 4).fillRect(17, 28, 8, 4);
      },
    },
    {
      key: "hero-archer",
      width: 28,
      height: 32,
      draw: (g) => {
        g.fillStyle(0x3a4734).fillRect(7, 3, 14, 10);
        g.fillStyle(0x8fd99d).fillRect(5, 13, 18, 15);
        g.fillStyle(0xd9ffe2).fillRect(10, 7, 8, 7);
        g.lineStyle(2, 0xc69b6d).strokeEllipse(23, 16, 8, 24);
        g.fillStyle(0x4f6957).fillRect(3, 28, 8, 4).fillRect(17, 28, 8, 4);
      },
    },
    {
      key: "hero-mage",
      width: 28,
      height: 32,
      draw: (g) => {
        g.fillStyle(0x4d315f).fillTriangle(4, 9, 24, 9, 14, 0);
        g.fillStyle(0xc69bff).fillRect(5, 13, 18, 15);
        g.fillStyle(0xf0ddff).fillRect(10, 7, 8, 7);
        g.fillStyle(0x8a62b8).fillRect(24, 6, 2, 25);
        g.fillStyle(0xe9d5ff).fillCircle(25, 5, 4);
        g.fillStyle(0x654477).fillRect(3, 28, 8, 4).fillRect(17, 28, 8, 4);
      },
    },
    {
      key: "enemy-grunt",
      width: 26,
      height: 26,
      draw: (g) => {
        g.fillStyle(0x35233f).fillRect(3, 5, 20, 18);
        g.fillStyle(0x80549a).fillRect(6, 2, 5, 6).fillRect(15, 2, 5, 6);
        g.fillStyle(0xf3a8ff).fillRect(7, 10, 4, 3).fillRect(15, 10, 4, 3);
        g.fillStyle(0x5a366d).fillRect(1, 21, 9, 5).fillRect(16, 21, 9, 5);
      },
    },
    {
      key: "enemy-runner",
      width: 22,
      height: 22,
      draw: (g) => {
        g.fillStyle(0x6e3659).fillTriangle(2, 19, 11, 2, 20, 19);
        g.fillStyle(0xff8ccb).fillRect(7, 9, 3, 3).fillRect(13, 9, 3, 3);
        g.fillStyle(0x9c517d).fillRect(3, 18, 6, 4).fillRect(14, 18, 6, 4);
      },
    },
    {
      key: "enemy-elite",
      width: 42,
      height: 42,
      draw: (g) => {
        g.fillStyle(0x25182e).fillRect(4, 8, 34, 30);
        g.fillStyle(0x9e5bc0).fillRect(1, 4, 10, 12).fillRect(31, 4, 10, 12);
        g.fillStyle(0xe9adff).fillRect(10, 17, 7, 5).fillRect(25, 17, 7, 5);
        g.fillStyle(0x6b3e82).fillRect(3, 35, 12, 7).fillRect(27, 35, 12, 7);
      },
    },
    {
      key: "gate",
      width: 62,
      height: 76,
      draw: (g) => {
        g.fillStyle(0x17111e).fillRect(4, 18, 54, 58);
        g.fillStyle(0x7e40a4).fillRect(0, 12, 12, 64).fillRect(50, 12, 12, 64).fillRect(8, 4, 46, 12);
        g.fillStyle(0xd073ff).fillEllipse(31, 45, 34, 48);
        g.fillStyle(0x2a1738).fillEllipse(31, 45, 20, 36);
      },
    },
    {
      key: "core",
      width: 72,
      height: 72,
      draw: (g) => {
        g.fillStyle(0x253c3b).fillRect(4, 14, 64, 54);
        g.fillStyle(0x77d8b2).fillRect(10, 20, 52, 42);
        g.fillStyle(0xd8fff0).fillCircle(36, 34, 17);
        g.fillStyle(0x477f72).fillCircle(36, 34, 9);
        g.fillStyle(0xd5b56d).fillRect(0, 62, 72, 10);
      },
    },
    {
      key: "turret",
      width: 34,
      height: 34,
      draw: (g) => {
        g.fillStyle(0x314348).fillRect(4, 8, 26, 22);
        g.fillStyle(0x6f9d9c).fillCircle(17, 16, 10);
        g.fillStyle(0xdff7d9).fillRect(15, 0, 5, 18);
        g.fillStyle(0x1d292c).fillRect(1, 28, 32, 6);
      },
    },
    {
      key: "wall",
      width: 38,
      height: 38,
      draw: (g) => {
        g.fillStyle(0x4e5157).fillRect(1, 7, 36, 30);
        g.fillStyle(0x7f858d).fillRect(3, 3, 13, 13).fillRect(22, 3, 13, 13);
        g.fillStyle(0x62666e).fillRect(9, 18, 20, 19);
        g.lineStyle(2, 0x2b2d31).strokeRect(1, 7, 36, 30);
      },
    },
    {
      key: "projectile",
      width: 12,
      height: 6,
      draw: (g) => g.fillStyle(0xffee9b).fillRect(0, 1, 10, 4).fillStyle(0xffffff).fillRect(8, 0, 4, 6),
    },
    {
      key: "magic-projectile",
      width: 14,
      height: 14,
      draw: (g) => g.fillStyle(0x6a38a0).fillCircle(7, 7, 7).fillStyle(0xe8c8ff).fillCircle(7, 7, 3),
    },
    {
      key: "enemy-projectile",
      width: 12,
      height: 12,
      draw: (g) => g.fillStyle(0x8f335e).fillCircle(6, 6, 6).fillStyle(0xff92bd).fillCircle(6, 6, 2),
    },
    {
      key: "boss",
      width: 112,
      height: 112,
      draw: (g) => {
        g.fillStyle(0x130d19).fillCircle(56, 58, 49);
        g.fillStyle(0x4d225e).fillTriangle(12, 25, 41, 31, 27, 0).fillTriangle(71, 31, 100, 25, 85, 0);
        g.fillStyle(0x803b9e).fillRect(25, 38, 62, 57);
        g.fillStyle(0xff8ed8).fillRect(36, 52, 13, 8).fillRect(64, 52, 13, 8);
        g.fillStyle(0x1b0f20).fillRect(51, 68, 11, 22);
        g.fillStyle(0xb35fd0).fillRect(17, 93, 78, 12);
      },
    },
  ];

  specs.forEach((spec) => {
    if (scene.textures.exists(spec.key)) return;
    const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
    spec.draw(graphics);
    graphics.generateTexture(spec.key, spec.width, spec.height);
    graphics.destroy();
  });
}
