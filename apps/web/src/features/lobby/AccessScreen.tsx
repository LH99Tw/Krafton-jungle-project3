"use client";

import type { Viewer } from "../game/GameShell";
import { AccessSidebar } from "./AccessSidebar";
import { FantasyButton } from "@/src/components/ui/FantasyButton";
import { Guestbook } from "../guestbook/Guestbook";

const LOCAL_DEVELOPMENT_TOOLS_ENABLED = process.env.NODE_ENV !== "production";

export function AccessScreen({
  viewer,
  busy,
  error,
  onGuest,
  onLogout,
  onStart,
  onOpenEditor,
  editorEnabled,
}: {
  viewer: Viewer;
  busy: boolean;
  error: string;
  onGuest: (displayName: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onStart: () => void;
  onOpenEditor: () => void;
  editorEnabled: boolean;
}) {
  return (
    <main className="access-screen">
      <AccessSidebar viewer={viewer} busy={busy} error={error} onGuest={onGuest} onLogout={onLogout} />

      <section className="access-stage" id="access-main">
        <div className="access-main-art" aria-hidden="true" />
        <Guestbook viewer={viewer} />
        <div className="access-launch">
          <p>{viewer
            ? "함께 탐험할 원정대를 찾으세요."
            : LOCAL_DEVELOPMENT_TOOLS_ENABLED
              ? "로그인 후 개발 도구와 원정대 로비를 이용해 보세요."
              : "로그인 후 함께 탐험할 원정대를 찾아보세요."}</p>
          <div className="access-launch-actions">
            {LOCAL_DEVELOPMENT_TOOLS_ENABLED && editorEnabled && (
              <FantasyButton variant="quiet" size="large" type="button" onClick={onOpenEditor}>
                로컬 맵 빌더
              </FantasyButton>
            )}
            <FantasyButton
              variant={LOCAL_DEVELOPMENT_TOOLS_ENABLED ? "secondary" : "primary"}
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
