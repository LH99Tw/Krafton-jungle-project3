"use client";

import { useEffect, useRef } from "react";
import type { UpgradeChoice, UpgradeId } from "@/src/game/domain/types";

export function UpgradeDraft({ choices, onChoose }: { choices: UpgradeChoice[]; onChoose: (id: UpgradeId) => void }) {
  const firstButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (choices.length === 0) return;
    firstButton.current?.focus();
    const handler = (event: KeyboardEvent) => {
      const index = Number(event.key) - 1;
      if (index >= 0 && index < choices.length) onChoose(choices[index].id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [choices, onChoose]);

  if (choices.length === 0) return null;

  return (
    <aside className="upgrade-dock" role="dialog" aria-modal="false" aria-labelledby="upgrade-title">
      <section className="upgrade-modal">
        <div className="upgrade-heading"><span>LEVEL UP · 전투 계속 진행 중</span><h2 id="upgrade-title">증강 선택</h2><p>1 / 2 / 3 키로 빠르게 선택</p></div>
        <div className="upgrade-grid">
          {choices.map((choice, index) => (
            <button
              type="button"
              key={choice.id}
              ref={index === 0 ? firstButton : undefined}
              className={`upgrade-card rarity-${choice.rarity}`}
              onClick={() => onChoose(choice.id)}
            >
              <span className="upgrade-key">0{index + 1}</span>
              <span className="upgrade-rarity">{choice.rarity === "epic" ? "EPIC" : choice.rarity === "rare" ? "RARE" : "NORMAL"}</span>
              <strong>{choice.name}</strong>
              <p>{choice.description}</p>
              <span className="upgrade-footer"><b>{choice.tag}</b><small>STACK {choice.stack}/{choice.maxStacks}</small></span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}

