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
          <div className="access-launch-actions">
            {editorEnabled && (
              <FantasyButton variant="quiet" size="large" type="button" onClick={onOpenEditor}>
                맵 빌더
              </FantasyButton>
            )}
            <FantasyButton
              variant="primary"
              size="large"
              type="button"
              onClick={onStart}
              disabled={!viewer || busy}
            >
              시작하기
            </FantasyButton>
          </div>
        </div>
      </section>
    </main>
  );
}
