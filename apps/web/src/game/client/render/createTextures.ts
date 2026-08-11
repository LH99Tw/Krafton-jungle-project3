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

  // 8-directional transparent pixel art skeleton with eye sockets facing player
  const SKELETON_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const;
  SKELETON_ANGLES.forEach((angle) => {
    specs.push({
      key: `enemy-skeleton-${angle}`,
      width: 32,
      height: 32,
      draw: (g) => {
        const rad = (angle * Math.PI) / 180;
        const dirX = Math.round(Math.cos(rad));
        const dirY = Math.round(Math.sin(rad));

        // Ground shadow
        g.fillStyle(0x000000, 0.4).fillEllipse(16, 28, 20, 7);

        // Stepping legs
        const legShift = Math.round(dirX * 3);
        g.fillStyle(0xe0e0e0).fillRect(11 - legShift, 20, 3, 7);
        g.fillStyle(0xaaaaaa).fillRect(10 - legShift, 26, 4, 2);
        g.fillStyle(0xe0e0e0).fillRect(18 + legShift, 20, 3, 7);
        g.fillStyle(0xaaaaaa).fillRect(18 + legShift, 26, 4, 2);

        // Spine & Ribcage
        g.fillStyle(0x999999).fillRect(14, 18, 4, 3);
        g.fillStyle(0xf0f0f0).fillRect(11, 11, 10, 7);
        g.fillStyle(0x666666)
          .fillRect(13, 12, 6, 1)
          .fillRect(13, 14, 6, 1)
          .fillRect(13, 16, 6, 1);

        // Wooden Shield (Left Side)
        const shieldX = 5 + dirX * 2;
        const shieldY = 10 + dirY * 2;
        g.fillStyle(0x3e2723).fillRect(shieldX, shieldY, 7, 10);
        g.fillStyle(0x6d4c41).fillRect(shieldX + 1, shieldY + 1, 5, 8);
        g.fillStyle(0xd4af37).fillRect(shieldX + 3, shieldY + 4, 2, 2);

        // Bone Sword (Right Side)
        const swordX = 21 + dirX * 2;
        const swordY = 7 + dirY * 2;
        g.fillStyle(0xe0e0e0).fillRect(swordX, swordY, 2, 11);
        g.fillStyle(0x757575).fillRect(swordX - 2, swordY + 9, 6, 2);

        // Skull Head
        g.fillStyle(0xffffff).fillRect(10 + dirX * 2, 2 + dirY * 2, 12, 10);
        g.fillStyle(0xdddddd).fillRect(11 + dirX * 2, 1 + dirY * 2, 10, 2);

        // Face & Eye Sockets facing player direction
        if (angle !== 270) { // If NOT facing away (270 deg is North/Back)
          // Glowing crimson eyes glaring directly at player
          const eyeOffX = dirX * 2;
          const eyeOffY = dirY * 2;

          // Eye Sockets
          g.fillStyle(0x1a0000)
            .fillRect(11 + eyeOffX, 5 + eyeOffY, 4, 4)
            .fillRect(17 + eyeOffX, 5 + eyeOffY, 4, 4);

          // Intense Glowing Crimson Pupils
          g.fillStyle(0xff0033)
            .fillRect(12 + eyeOffX, 6 + eyeOffY, 2, 2)
            .fillRect(18 + eyeOffX, 6 + eyeOffY, 2, 2);

          // White Pupil Core Center
          g.fillStyle(0xffffff)
            .fillRect(13 + eyeOffX, 6 + eyeOffY, 1, 1)
            .fillRect(19 + eyeOffX, 6 + eyeOffY, 1, 1);

          // Skull Teeth Grid
          g.fillStyle(0xdddddd).fillRect(12 + eyeOffX, 10 + eyeOffY, 8, 3);
          g.fillStyle(0x222222)
            .fillRect(13 + eyeOffX, 10 + eyeOffY, 1, 3)
            .fillRect(15 + eyeOffX, 10 + eyeOffY, 1, 3)
            .fillRect(17 + eyeOffX, 10 + eyeOffY, 1, 3);
        } else {
          // Back of skull (North / 270 deg)
          g.fillStyle(0xd0d0d0).fillRect(11, 3, 10, 8);
          g.fillStyle(0x888888).fillRect(14, 10, 4, 3);
        }
      },
    });
  });

  specs.forEach((spec) => {
    if (scene.textures.exists(spec.key)) return;
    const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
    spec.draw(graphics);
    graphics.generateTexture(spec.key, spec.width, spec.height);
    graphics.destroy();
  });
}
