"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { UpgradeChoice, UpgradeId } from "@/src/game/domain/types";

const CARD_IMAGE_BY_RARITY: Record<UpgradeChoice["rarity"], string> = {
  normal: "/Asset/ui/augment-cards/augment-card-normal.webp",
  rare: "/Asset/ui/augment-cards/augment-card-rare.webp",
  epic: "/Asset/ui/augment-cards/augment-card-epic.webp",
};

const SELECTION_EXIT_MS = 480;
const SELECTION_RETRY_MS = 1_800;
let cardFramePreload: HTMLImageElement[] | null = null;

function preloadCardFrames(): void {
  if (cardFramePreload || typeof window === "undefined") return;
  cardFramePreload = [...new Set(Object.values(CARD_IMAGE_BY_RARITY))].map((source) => {
    const image = new window.Image();
    image.decoding = "async";
    image.src = source;
    void image.decode().catch(() => undefined);
    return image;
  });
}

function primaryStat(description: string): string {
  const signedStat = description.match(/[+-]\d+(?:\.\d+)?(?:%p|%|초|발)?/);
  if (signedStat) return signedStat[0];
  return description.match(/\d+(?:\.\d+)?(?:%p|%|초|발)?/)?.[0] ?? "NEW";
}

export function UpgradeDraft({ choices, onChoose }: { choices: UpgradeChoice[]; onChoose: (id: UpgradeId) => void }) {
  const firstButton = useRef<HTMLButtonElement>(null);
  const selectedRef = useRef<UpgradeId | null>(null);
  const commitTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const [selectedId, setSelectedId] = useState<UpgradeId | null>(null);

  useEffect(preloadCardFrames, []);

  const chooseWithExit = useCallback((id: UpgradeId) => {
    if (selectedRef.current || !choices.some((choice) => choice.id === id)) return;
    selectedRef.current = id;
    setSelectedId(id);
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null;
      onChoose(id);
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        selectedRef.current = null;
        setSelectedId(null);
      }, SELECTION_RETRY_MS);
    }, SELECTION_EXIT_MS);
  }, [choices, onChoose]);

  useEffect(() => {
    if (choices.length === 0) return;
    firstButton.current?.focus();
    const handler = (event: KeyboardEvent) => {
      const index = Number(event.key) - 1;
      if (index >= 0 && index < choices.length) chooseWithExit(choices[index].id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [choices, chooseWithExit]);

  useEffect(() => () => {
    if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
  }, []);

  if (choices.length === 0) return null;

  return (
    <aside className="upgrade-dock" role="dialog" aria-modal="false" aria-labelledby="upgrade-title">
      <section className="upgrade-modal">
        <div className="upgrade-heading">
          <span>LEVEL UP</span>
          <h2 id="upgrade-title">증강 선택</h2>
          <p>1 · 2 · 3 키로 선택</p>
        </div>
        <div className={`upgrade-grid ${selectedId ? "is-leaving" : ""}`}>
          {choices.map((choice, index) => (
            <button
              type="button"
              key={choice.id}
              ref={index === 0 ? firstButton : undefined}
              className={`upgrade-card rarity-${choice.rarity} ${selectedId === choice.id ? "is-selected" : selectedId ? "is-dismissed" : ""}`}
              onClick={() => chooseWithExit(choice.id)}
              disabled={selectedId !== null}
              aria-pressed={selectedId === choice.id}
            >
              <Image
                className="upgrade-card-frame"
                src={CARD_IMAGE_BY_RARITY[choice.rarity]}
                alt=""
                aria-hidden="true"
                draggable="false"
                fill
                sizes="(max-width: 680px) 32.5vw, 182px"
                unoptimized
              />
              <span className="upgrade-key">{index + 1}</span>
              <strong className="upgrade-card-title">{choice.name}</strong>
              <em className="upgrade-value">{primaryStat(choice.description)}</em>
              <p className="upgrade-description">{choice.description}</p>
              <span className="upgrade-footer"><b>{choice.tag}</b><small>STACK {choice.stack}/{choice.maxStacks}</small></span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
