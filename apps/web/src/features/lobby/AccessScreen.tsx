"use client";

import { useState } from "react";
import type { Viewer } from "../game/GameShell";
import { AccessSidebar } from "./AccessSidebar";
import { FantasyButton } from "@/src/components/ui/FantasyButton";

export function AccessScreen({
  viewer,
  busy,
  error,
  onGuest,
  onLogout,
  onStart,
}: {
  viewer: Viewer;
  busy: boolean;
  error: string;
  onGuest: (displayName: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onStart: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <main className="access-screen">
      <AccessSidebar viewer={viewer} busy={busy} error={error} onGuest={onGuest} onLogout={onLogout} />

      <section className="access-stage" id="access-main">
        <div className="access-main-art" aria-hidden="true" />
        <div className="access-copy">
          <p className="access-kicker">왕국의 마지막 원정</p>
          <h1><small>마왕이 오기까지</small>단, 5일</h1>
          <p>낮에는 황폐한 영지를 개척하고, 밤에는 세 명의 용사가 함께 성벽을 지킵니다.</p>
          <button className="detail-toggle" type="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)}>
            {detailsOpen ? "원정 규칙 닫기" : "원정 규칙 보기"}<span aria-hidden="true">＋</span>
          </button>
          {detailsOpen ? <div className="access-details"><span>3인 협동</span><span>낮 탐험 / 밤 방어</span><span>5일차 마왕 레이드</span></div> : null}
        </div>
        <div className="access-launch">
          <p>{viewer ? "함께 싸울 원정대를 찾으세요." : "왼쪽에서 먼저 접속해 주세요."}</p>
          <FantasyButton variant="secondary" size="large" type="button" onClick={onStart} disabled={!viewer || busy} trailingIcon="→">원정대 찾기</FantasyButton>
        </div>
      </section>
    </main>
  );
}
