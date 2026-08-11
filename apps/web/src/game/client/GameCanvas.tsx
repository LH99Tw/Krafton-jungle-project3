"use client";

import { useEffect, useRef, useState } from "react";
import type { GameStartOptions } from "../domain/types";
import { gameBridge } from "../runtime/GameBridge";

type GameCanvasProps = {
  options: GameStartOptions;
};

export function GameCanvas({ options }: GameCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState({ progress: 0, label: "게임 클라이언트 불러오는 중" });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let destroy: (() => void) | undefined;
    const offLoading = gameBridge.on("loading", (value) => {
      if (!disposed) setLoading(value);
    });
    const offReady = gameBridge.on("ready", () => {
      if (!disposed) setReady(true);
    });

    void import("../runtime/createGame").then(({ createGame }) => {
      if (disposed) return;
      const game = createGame(host, options);
      destroy = () => game.destroy(true);
    });

    return () => {
      disposed = true;
      offLoading();
      offReady();
      destroy?.();
      host.replaceChildren();
    };
  }, [options]);

  return <div className="game-canvas-shell">
    <div
      ref={hostRef}
      className="game-canvas"
      role="application"
      aria-label="5일 뒤 마왕 전투 화면. WASD로 이동하고 Q, E, Space 키로 스킬을 사용합니다."
    />
    {!ready && <div className="game-loading" role="status" aria-live="polite">
      <div className="game-loading__title">원정 준비 중</div>
      <div className="game-loading__track"><i style={{ width: `${Math.round(loading.progress * 100)}%` }} /></div>
      <div className="game-loading__status">{loading.label} · {Math.round(loading.progress * 100)}%</div>
    </div>}
  </div>;
}
