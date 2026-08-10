"use client";

import { useEffect, useRef } from "react";
import type { GameStartOptions } from "../domain/types";

type GameCanvasProps = {
  options: GameStartOptions;
};

export function GameCanvas({ options }: GameCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let destroy: (() => void) | undefined;

    void import("../runtime/createGame").then(({ createGame }) => {
      if (disposed) return;
      const game = createGame(host, options);
      destroy = () => game.destroy(true);
    });

    return () => {
      disposed = true;
      destroy?.();
      host.replaceChildren();
    };
  }, [options]);

  return (
    <div
      ref={hostRef}
      className="game-canvas"
      role="application"
      aria-label="5일 뒤 마왕 전투 화면. WASD로 이동하고 Q, E, Space 키로 스킬을 사용합니다."
    />
  );
}

