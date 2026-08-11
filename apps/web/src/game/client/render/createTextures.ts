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

  // 8-directional transparent pixel art skeleton (Normal Mob)
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
        if (angle !== 270) {
          const eyeOffX = dirX * 2;
          const eyeOffY = dirY * 2;

          g.fillStyle(0x1a0000)
            .fillRect(11 + eyeOffX, 5 + eyeOffY, 4, 4)
            .fillRect(17 + eyeOffX, 5 + eyeOffY, 4, 4);

          g.fillStyle(0xff0033)
            .fillRect(12 + eyeOffX, 6 + eyeOffY, 2, 2)
            .fillRect(18 + eyeOffX, 6 + eyeOffY, 2, 2);

          g.fillStyle(0xffffff)
            .fillRect(13 + eyeOffX, 6 + eyeOffY, 1, 1)
            .fillRect(19 + eyeOffX, 6 + eyeOffY, 1, 1);

          g.fillStyle(0xdddddd).fillRect(12 + eyeOffX, 10 + eyeOffY, 8, 3);
          g.fillStyle(0x222222)
            .fillRect(13 + eyeOffX, 10 + eyeOffY, 1, 3)
            .fillRect(15 + eyeOffX, 10 + eyeOffY, 1, 3)
            .fillRect(17 + eyeOffX, 10 + eyeOffY, 1, 3);
        } else {
          g.fillStyle(0xd0d0d0).fillRect(11, 3, 10, 8);
          g.fillStyle(0x888888).fillRect(14, 10, 4, 3);
        }
      },
    });
  });

  // 8-directional high-detail pixel art Demon Lord Mid-Boss (Imposing Winged Demon Overlord - Refined)
  const DEMON_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const;
  DEMON_ANGLES.forEach((angle) => {
    specs.push({
      key: `enemy-demon-midboss-${angle}`,
      width: 84,
      height: 84,
      draw: (g) => {
        const rad = (angle * Math.PI) / 180;
        const dirX = Math.round(Math.cos(rad));
        const dirY = Math.round(Math.sin(rad));

        // 1. Swirling Dark Fiery Demonic Aura & Soft Ground Shadow
        g.fillStyle(0x360522, 0.4).fillCircle(42, 46, 36);
        g.fillStyle(0xd90f38, 0.18).fillCircle(42, 46, 26);
        g.fillStyle(0x000000, 0.55).fillEllipse(42, 75, 48, 14);

        // 2. High-Detail Bat/Dragon Demon Wings (Curved Ribbed Wings with Webbed Veins)
        // Left Wing Structural Bones & Membrane
        g.fillStyle(0x130a1c).fillTriangle(42, 36, 2, 8, 16, 52);
        g.fillStyle(0x5e0d22).fillTriangle(40, 38, 6, 12, 20, 48);
        g.fillStyle(0x9e172e).fillTriangle(38, 40, 10, 18, 22, 44);
        g.fillStyle(0xe62e3d).fillTriangle(36, 42, 14, 24, 24, 40);

        // Left Wing Rib Lines (Veins)
        g.fillStyle(0x130a1c)
          .fillTriangle(2, 8, 8, 4, 1, 16)
          .fillTriangle(2, 8, 18, 16, 10, 26)
          .fillTriangle(2, 8, 22, 34, 14, 42);
        g.fillStyle(0xff2b46).fillCircle(2, 8, 2.5); // Wingtip Claw Gem

        // Right Wing Structural Bones & Membrane
        g.fillStyle(0x130a1c).fillTriangle(42, 36, 82, 8, 68, 52);
        g.fillStyle(0x5e0d22).fillTriangle(44, 38, 78, 12, 64, 48);
        g.fillStyle(0x9e172e).fillTriangle(46, 40, 74, 18, 62, 44);
        g.fillStyle(0xe62e3d).fillTriangle(48, 42, 70, 24, 60, 40);

        // Right Wing Rib Lines (Veins)
        g.fillStyle(0x130a1c)
          .fillTriangle(82, 8, 76, 4, 83, 16)
          .fillTriangle(82, 8, 66, 16, 74, 26)
          .fillTriangle(82, 8, 62, 34, 70, 42);
        g.fillStyle(0xff2b46).fillCircle(82, 8, 2.5); // Wingtip Claw Gem

        // 3. Spiked Curved Demon Tail
        const tailX = 42 + dirX * 10;
        g.fillStyle(0x180d21).fillTriangle(tailX, 56, tailX + 18, 64, tailX + 10, 74);
        g.fillStyle(0x87122a).fillTriangle(tailX + 10, 62, tailX + 22, 66, tailX + 16, 74);

        // 4. Muscular Obsidian Legs, Knee Guards & Armor Boots
        const legShift = Math.round(dirX * 5);

        // Left Leg
        g.fillStyle(0x130b1a).fillRect(27 - legShift, 46, 11, 24);
        g.fillStyle(0x2f1c3d).fillRect(26 - legShift, 46, 4, 24); // Metallic Highlight
        g.fillStyle(0x3b244d).fillRect(26 - legShift, 65, 13, 6); // Boot Base
        g.fillStyle(0x8a122b).fillRect(29 - legShift, 52, 6, 6); // Knee Rune
        g.fillStyle(0xff2b46).fillRect(30 - legShift, 53, 4, 4);

        // Right Leg
        g.fillStyle(0x130b1a).fillRect(46 + legShift, 46, 11, 24);
        g.fillStyle(0x2f1c3d).fillRect(54 + legShift, 46, 4, 24); // Metallic Highlight
        g.fillStyle(0x3b244d).fillRect(45 + legShift, 65, 13, 6); // Boot Base
        g.fillStyle(0x8a122b).fillRect(49 + legShift, 52, 6, 6); // Knee Rune
        g.fillStyle(0xff2b46).fillRect(50 + legShift, 53, 4, 4);

        // 5. V-Shaped Torso Armor & Glowing Crimson Core
        g.fillStyle(0x1a0f26).fillTriangle(24, 26, 60, 26, 42, 50); // Torso Base
        g.fillStyle(0x2d1a40).fillTriangle(26, 27, 58, 27, 42, 48); // Armor Plate
        g.fillStyle(0x0e0714).fillRect(32, 30, 20, 16); // Inner Core Frame

        // Glowing Core Crystal
        g.fillStyle(0x610c22).fillCircle(42, 38, 8);
        g.fillStyle(0xc41438).fillCircle(42, 38, 6);
        g.fillStyle(0xff3352).fillCircle(42, 38, 4);
        g.fillStyle(0xffc2cc).fillCircle(42, 37, 1.5);

        // 6. Layered Spiked Pauldrons (Shoulders)
        // Left Shoulder
        g.fillStyle(0x341d47).fillTriangle(14, 30, 28, 20, 28, 42);
        g.fillStyle(0x563175).fillTriangle(16, 30, 27, 22, 27, 40);
        g.fillStyle(0x87122a).fillTriangle(10, 30, 17, 26, 17, 34);
        g.fillStyle(0xff2a48).fillCircle(12, 30, 2);

        // Right Shoulder
        g.fillStyle(0x341d47).fillTriangle(70, 30, 56, 20, 56, 42);
        g.fillStyle(0x563175).fillTriangle(68, 30, 57, 22, 57, 40);
        g.fillStyle(0x87122a).fillTriangle(74, 30, 67, 26, 67, 34);
        g.fillStyle(0xff2a48).fillCircle(72, 30, 2);

        // 7. Refined Jagged Demon Greatsword with Fiery Energy Core
        const bladeX = 59 + dirX * 5;
        const bladeY = 14 + dirY * 4;

        // Sword Guard & Pommel
        g.fillStyle(0x11091a).fillRect(bladeX - 7, bladeY + 36, 18, 5);
        g.fillStyle(0x8a122a).fillCircle(bladeX + 2, bladeY + 38, 3.5);
        g.fillStyle(0xff2a48).fillCircle(bladeX + 2, bladeY + 38, 1.5);

        // Jagged Blade (Tapered Shape)
        g.fillStyle(0x130b1a).fillTriangle(bladeX - 4, bladeY + 36, bladeX + 8, bladeY + 36, bladeX + 2, bladeY - 8);
        g.fillStyle(0x2c1a3d).fillTriangle(bladeX - 2, bladeY + 34, bladeX + 6, bladeY + 34, bladeX + 2, bladeY - 6);

        // Glowing Crimson Energy Channel & Core Spike
        g.fillStyle(0x8a122b).fillRect(bladeX, bladeY, 4, 32);
        g.fillStyle(0xff2647).fillRect(bladeX + 1, bladeY + 2, 2, 28);
        g.fillStyle(0xffe6eb).fillRect(bladeX + 1, bladeY + 6, 2, 14);

        // 8. Evil Menacing Demon Helmet, Slanted Vicious Eyes & Graceful Curved Horns
        const headX = 28 + dirX * 3;
        const headY = 8 + dirY * 3;

        // Helmet Base
        g.fillStyle(0x11091a).fillRect(headX, headY, 28, 20);
        g.fillStyle(0x2f1c3d).fillRect(headX + 2, headY - 1, 24, 5);

        // Sweeping Curved Horns (Archdemon Horn Silhouette)
        const hornOffX = dirX * 3;
        const hornOffY = dirY * 3;

        // Left Horn
        g.fillStyle(0x11091a).fillTriangle(headX - 4 + hornOffX, headY + 12 + hornOffY, headX + 4 + hornOffX, headY + 4 + hornOffY, headX - 12 + hornOffX, headY - 10 + hornOffY);
        g.fillStyle(0x6e1228).fillTriangle(headX - 3 + hornOffX, headY + 10 + hornOffY, headX + 3 + hornOffX, headY + 4 + hornOffY, headX - 11 + hornOffX, headY - 8 + hornOffY);
        g.fillStyle(0xff2b46).fillTriangle(headX - 6 + hornOffX, headY - 2 + hornOffY, headX - 2 + hornOffX, headY + 3 + hornOffY, headX - 11 + hornOffX, headY - 8 + hornOffY);

        // Right Horn
        g.fillStyle(0x11091a).fillTriangle(headX + 32 + hornOffX, headY + 12 + hornOffY, headX + 24 + hornOffX, headY + 4 + hornOffY, headX + 40 + hornOffX, headY - 10 + hornOffY);
        g.fillStyle(0x6e1228).fillTriangle(headX + 31 + hornOffX, headY + 10 + hornOffY, headX + 25 + hornOffX, headY + 4 + hornOffY, headX + 39 + hornOffX, headY - 8 + hornOffY);
        g.fillStyle(0xff2b46).fillTriangle(headX + 34 + hornOffX, headY - 2 + hornOffY, headX + 30 + hornOffX, headY + 3 + hornOffY, headX + 39 + hornOffX, headY - 8 + hornOffY);

        // Vicious Angry Eyes (Slanted Evil Brow) facing direction
        if (angle !== 270) {
          const eyeOffX = dirX * 4;
          const eyeOffY = dirY * 3;

          // Dark Eye Sockets
          g.fillStyle(0x0a0003).fillRect(headX + 3 + eyeOffX, headY + 7 + eyeOffY, 9, 6).fillRect(headX + 16 + eyeOffX, headY + 7 + eyeOffY, 9, 6);

          // Slanted Angry Brow (Overhanging dark brow shadow for evil expression)
          g.fillStyle(0x11091a)
            .fillTriangle(headX + 3 + eyeOffX, headY + 7 + eyeOffY, headX + 12 + eyeOffX, headY + 7 + eyeOffY, headX + 12 + eyeOffX, headY + 10 + eyeOffY)
            .fillTriangle(headX + 25 + eyeOffX, headY + 7 + eyeOffY, headX + 16 + eyeOffX, headY + 7 + eyeOffY, headX + 16 + eyeOffX, headY + 10 + eyeOffY);

          // Slanted Fierce Crimson Eyes (Sharp Angled Glow)
          g.fillStyle(0xff0038)
            .fillTriangle(headX + 4 + eyeOffX, headY + 11 + eyeOffY, headX + 11 + eyeOffX, headY + 8 + eyeOffY, headX + 11 + eyeOffX, headY + 12 + eyeOffY)
            .fillTriangle(headX + 24 + eyeOffX, headY + 11 + eyeOffY, headX + 17 + eyeOffX, headY + 8 + eyeOffY, headX + 17 + eyeOffX, headY + 12 + eyeOffY);

          // Bright Glowing Pupil Dots
          g.fillStyle(0xffe600)
            .fillRect(headX + 9 + eyeOffX, headY + 9 + eyeOffY, 2, 2)
            .fillRect(headX + 17 + eyeOffX, headY + 9 + eyeOffY, 2, 2);

          // Dark Evil Visor Grille / Chin Guard (No goofy white teeth!)
          g.fillStyle(0x290a14).fillRect(headX + 7 + eyeOffX, headY + 14 + eyeOffY, 14, 4);
          g.fillStyle(0x800c22).fillRect(headX + 9 + eyeOffX, headY + 15 + eyeOffY, 10, 2);
        } else {
          // Back of Head
          g.fillStyle(0x1a0f26).fillRect(headX + 3, headY + 3, 22, 14);
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
