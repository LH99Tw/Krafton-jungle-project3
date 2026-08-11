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
}: {
  viewer: Viewer;
  busy: boolean;
  error: string;
  onGuest: (displayName: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onStart: () => void;
  onOpenEditor: () => void;
}) {
  return (
    <main className="access-screen">
      <AccessSidebar viewer={viewer} busy={busy} error={error} onGuest={onGuest} onLogout={onLogout} />

      <section className="access-stage" id="access-main">
        <div className="access-main-art" aria-hidden="true" />
        <Guestbook viewer={viewer} />
        <div className="access-launch">
          <p>{viewer ? "함께 싸울 원정대를 찾으세요." : "왼쪽에서 먼저 접속해 주세요."}</p>
          <div className="access-launch-actions">
            <FantasyButton variant="quiet" size="large" type="button" onClick={onOpenEditor} trailingIcon="⌘">로컬 맵 빌더</FantasyButton>
            <FantasyButton variant="secondary" size="large" type="button" onClick={onStart} disabled={!viewer || busy} trailingIcon="→">원정대 찾기</FantasyButton>
          </div>
        </div>
      </section>
    </main>
  );
}
