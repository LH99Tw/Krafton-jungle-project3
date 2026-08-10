"use client";

import { useState, type FormEvent } from "react";
import type { Viewer } from "../game/GameShell";

export function AccessSidebar({
  viewer,
  busy,
  error,
  onGuest,
  onLogout,
}: {
  viewer: Viewer;
  busy: boolean;
  error: string;
  onGuest: (displayName: string) => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [guestName, setGuestName] = useState("");

  async function submitGuest(event: FormEvent) {
    event.preventDefault();
    await onGuest(guestName);
  }

  return (
    <aside className="access-rail">
      <div className="access-rail-art" aria-hidden="true" />
      <a className="sr-only" href="#access-main">5일 뒤 마왕 메인 화면으로 이동</a>

      <section className="access-auth" aria-label="계정 정보">
        {viewer ? (
          <div className="access-profile">
            <div className="profile-rune" aria-hidden="true">{viewer.displayName.slice(0, 1)}</div>
            <div>
              <strong>{viewer.displayName}</strong>
              <span className="online-label">접속됨</span>
            </div>
            <button type="button" disabled={busy} onClick={() => void onLogout()}>로그아웃</button>
          </div>
        ) : (
          <>
            <h2>원정대에 합류하기</h2>
            <p>기록을 남길 계정으로 접속하거나, 이름만 정하고 바로 시작하세요.</p>
            <a className="google-login" href="/api/auth/login?returnTo=/">Google 계정으로 접속</a>
            <div className="auth-divider"><span>게스트 입장</span></div>
            <form className="guest-form" onSubmit={submitGuest}>
              <label htmlFor="guest-name">용사의 이름</label>
              <div>
                <input id="guest-name" value={guestName} onChange={(event) => setGuestName(event.target.value)} maxLength={16} placeholder="2~16자 이름" autoComplete="nickname" />
                <button disabled={busy} type="submit">입장</button>
              </div>
            </form>
          </>
        )}
        {error ? <p className="surface-error" role="alert">{error}</p> : null}
      </section>
    </aside>
  );
}
