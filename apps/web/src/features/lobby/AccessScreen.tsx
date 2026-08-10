"use client";

import { useState, type FormEvent } from "react";
import type { Viewer } from "../game/GameShell";

export function AccessScreen({
  viewer,
  busy,
  error,
  onGuest,
  onStart,
}: {
  viewer: Viewer;
  busy: boolean;
  error: string;
  onGuest: (displayName: string) => Promise<void>;
  onStart: () => void;
}) {
  const [guestName, setGuestName] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);

  async function submitGuest(event: FormEvent) {
    event.preventDefault();
    await onGuest(guestName);
  }

  return (
    <main className="access-screen">
      <aside className="access-rail">
        <a className="access-brand" href="#access-main" aria-label="5일 뒤 마왕">
          <span>V</span>
          <strong>5일 뒤 마왕</strong>
          <small>FIVE DAYS TO THE DEMON KING</small>
        </a>

        <div className="access-auth">
          <span className="access-step">01 / ACCESS</span>
          {viewer ? (
            <div className="access-profile">
              <div className="profile-rune" aria-hidden="true">{viewer.displayName.slice(0, 1)}</div>
              <div><small>{viewer.accountType === "guest" ? "GUEST OPERATIVE" : "VERIFIED OPERATIVE"}</small><strong>{viewer.displayName}</strong></div>
              <span className="online-label">접속 승인</span>
            </div>
          ) : (
            <>
              <h2>작전 참가</h2>
              <p>계정으로 기록을 남기거나, 이름만 정하고 바로 합류하세요.</p>
              <a className="google-login" href="/api/auth/login?returnTo=/">Google 계정으로 계속</a>
              <div className="auth-divider"><span>또는 게스트</span></div>
              <form className="guest-form" onSubmit={submitGuest}>
                <label htmlFor="guest-name">작전명</label>
                <div><input id="guest-name" value={guestName} onChange={(event) => setGuestName(event.target.value)} maxLength={16} placeholder="2~16자 이름" autoComplete="nickname" /><button disabled={busy} type="submit">입장</button></div>
              </form>
            </>
          )}
          {error ? <p className="surface-error" role="alert">{error}</p> : null}
        </div>

        <div className="access-rail-footer"><span className="status-dot" /> PROTOTYPE SERVER · ONLINE</div>
      </aside>

      <section className="access-stage" id="access-main">
        <div className="access-art" aria-hidden="true" />
        <div className="access-copy">
          <span className="access-kicker">왕국 최후의 원정대 모집</span>
          <h1><small>마왕이 오기까지</small>단, 5일.</h1>
          <p>세 명의 신참 용사가 낮에는 욕심내고, 밤에는 함께 살아남습니다.</p>
          <button className="detail-toggle" type="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)}>
            {detailsOpen ? "작전 정보 닫기" : "상세 설명"}<span aria-hidden="true">↗</span>
          </button>
          {detailsOpen ? <div className="access-details"><span>3인 협동</span><span>낮 탐험 / 밤 방어</span><span>5일차 마왕 레이드</span></div> : null}
        </div>
        <div className="access-launch">
          <div><small>NEXT</small><strong>{viewer ? "공개 원정대를 찾습니다" : "먼저 접속 방식을 선택하세요"}</strong></div>
          <button type="button" onClick={onStart} disabled={!viewer || busy}><span>시작하기</span><i aria-hidden="true">→</i></button>
        </div>
      </section>
    </main>
  );
}
