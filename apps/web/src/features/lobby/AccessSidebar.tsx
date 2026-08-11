"use client";

import { useState, type FormEvent } from "react";
import Image from "next/image";
import type { Viewer } from "../game/GameShell";
import { FantasyButton } from "@/src/components/ui/FantasyButton";

const PROFILE_BADGES = [
  { name: "검의 문장", src: "/images/ui/profile-badges/sword.png" },
  { name: "까마귀의 문장", src: "/images/ui/profile-badges/raven.png" },
  { name: "달의 문장", src: "/images/ui/profile-badges/moon.png" },
  { name: "탑의 문장", src: "/images/ui/profile-badges/tower.png" },
  { name: "늑대의 문장", src: "/images/ui/profile-badges/wolf.png" },
  { name: "성배의 문장", src: "/images/ui/profile-badges/chalice.png" },
] as const;

function profileBadgeFor(userId: string) {
  let hash = 2166136261;

  for (const character of userId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }

  return PROFILE_BADGES[(hash >>> 0) % PROFILE_BADGES.length];
}

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
  const profileBadge = viewer ? profileBadgeFor(viewer.userId) : null;
  const guestNameLength = guestName.trim().length;

  async function submitGuest(event: FormEvent) {
    event.preventDefault();
    await onGuest(guestName);
  }

  return (
    <aside className="access-rail">
      <div className="access-rail-art" aria-hidden="true" />
      <div className="access-rail-brand-art" role="img" aria-label="5일 뒤 마왕" />
      <a className="sr-only" href="#access-main">시작 화면으로 이동</a>

      <section className="access-auth" aria-label="계정 정보">
        {viewer ? (
          <div className="access-profile">
            <div className="profile-badge" title={profileBadge?.name}>
              {profileBadge ? <Image src={profileBadge.src} alt="" width={512} height={512} sizes="64px" priority /> : null}
              <span className="sr-only">{profileBadge?.name}</span>
            </div>
            <div className="profile-copy">
              <strong>{viewer.displayName}</strong>
              <span className="online-label">접속됨</span>
            </div>
            <FantasyButton className="profile-logout" variant="quiet" size="small" fullWidth type="button" disabled={busy} onClick={() => void onLogout()}>로그아웃</FantasyButton>
          </div>
        ) : (
          <>
            <h2>원정대에 합류하기</h2>
            <p>원정에 참여할 계정으로 접속하거나, 이름만 정하고 바로 시작하세요.</p>
            <FantasyButton className="google-login" variant="primary" href="/api/auth/login?returnTo=/" fullWidth>Google 계정으로 접속</FantasyButton>
            <div className="auth-divider"><span>게스트 입장</span></div>
            <form className="guest-form" onSubmit={submitGuest}>
              <label htmlFor="guest-name">용사의 이름</label>
              <div>
                <input id="guest-name" value={guestName} onChange={(event) => setGuestName(event.target.value)} minLength={2} maxLength={6} required placeholder="2~6자 이름" autoComplete="nickname" />
                <FantasyButton className="guest-enter" variant="secondary" size="small" disabled={busy || guestNameLength < 2 || guestNameLength > 6} type="submit">입장</FantasyButton>
              </div>
            </form>
          </>
        )}
        {error ? <p className="surface-error" role="alert">{error}</p> : null}
      </section>
    </aside>
  );
}
