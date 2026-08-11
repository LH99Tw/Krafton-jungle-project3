"use client";

import type { Viewer } from "../game/GameShell";
import { AccessSidebar } from "./AccessSidebar";
import { FantasyButton } from "@/src/components/ui/FantasyButton";
import { Guestbook } from "../guestbook/Guestbook";

export function AccessScreen({
  viewer,
  busy,
  error,
  onGuest,
  onLogout,
  onStart,
  onQuickPlayMage,
  onOpenEditor,
  onOpenLab,
  editorEnabled,
}: {
  viewer: Viewer;
  busy: boolean;
  error: string;
  onGuest: (displayName: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onStart: () => void;
  onQuickPlayMage?: () => void;
  onOpenEditor: () => void;
  onOpenLab?: () => void;
  editorEnabled: boolean;
}) {
  return (
    <main className="access-screen">
      <AccessSidebar viewer={viewer} busy={busy} error={error} onGuest={onGuest} onLogout={onLogout} />

      <section className="access-stage" id="access-main">
        <div className="access-main-art" aria-hidden="true" />
        <Guestbook viewer={viewer} />
        <div className="access-launch">
          <p>{viewer ? "함께 탐험할 원정대를 찾으세요." : "마법사로 바로 시작하거나 증강 실험실을 이용해 보세요."}</p>
          <div className="access-launch-actions">
            {process.env.NODE_ENV !== "production" && editorEnabled && (
              <FantasyButton variant="quiet" size="large" type="button" onClick={onOpenEditor}>
                로컬 맵 빌더
              </FantasyButton>
            )}
            {onOpenLab && (
              <FantasyButton variant="quiet" size="large" type="button" onClick={onOpenLab}>
                🧪 증강 밸런스 실험실
              </FantasyButton>
            )}
            <FantasyButton
              variant="primary"
              size="large"
              type="button"
              onClick={onQuickPlayMage || onStart}
              disabled={busy}
            >
              🧙 마법사로 바로 시작하기
            </FantasyButton>
            <FantasyButton
              variant="secondary"
              size="large"
              type="button"
              onClick={onStart}
              disabled={!viewer || busy}
            >
              🛡️ 원정대 찾기 (로비)
            </FantasyButton>
          </div>
        </div>
      </section>
    </main>
  );
}