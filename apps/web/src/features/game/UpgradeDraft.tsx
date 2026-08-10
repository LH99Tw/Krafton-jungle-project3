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
    <div className="modal-backdrop upgrade-backdrop" role="dialog" aria-modal="true" aria-labelledby="upgrade-title">
      <section className="upgrade-modal">
        <div className="upgrade-heading"><span>LEVEL UP · TEAM EXP SHARED</span><h2 id="upgrade-title">이번 원정의 방향을 선택하세요</h2><p>전투는 계속됩니다. 숫자 키 1–3으로도 즉시 선택할 수 있습니다.</p></div>
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
    </div>
  );
}

