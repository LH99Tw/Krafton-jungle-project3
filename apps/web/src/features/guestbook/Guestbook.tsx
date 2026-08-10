"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Viewer } from "../game/GameShell";

type Entry = {
  id: number;
  authorName: string;
  content: string;
  createdAt: string;
};

const FALLBACK_ENTRIES: Entry[] = [
  { id: -1, authorName: "왕국 기록관", content: "첫 원정대 모집이 시작되었습니다. 살아서 결과를 남겨주세요.", createdAt: "방금 전" },
  { id: -2, authorName: "익명의 궁수", content: "3일차 전직에서 탄막 빌드가 뜨면 마왕 체력바가 녹습니다.", createdAt: "오늘" },
];

export function Guestbook({ viewer }: { viewer: Viewer }) {
  const [entries, setEntries] = useState<Entry[]>(FALLBACK_ENTRIES);
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    let alive = true;
    void fetch("/api/guestbook")
      .then(async (response) => {
        if (!response.ok) return { entries: [] };
        const text = await response.text();
        return text ? (JSON.parse(text) as { entries?: Entry[] }) : { entries: [] };
      })
      .then((payload) => {
        if (alive && payload.entries?.length) setEntries(payload.entries);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!viewer || content.trim().length < 2) return;
    setStatus("기록 중…");
    try {
      const response = await fetch("/api/guestbook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": viewer.csrfToken,
        },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        setStatus("지금은 기록을 남길 수 없습니다.");
        return;
      }
      const text = await response.text();
      const payload = text ? (JSON.parse(text) as { entry?: Entry }) : null;
      if (payload?.entry) {
        setEntries((current) => [payload.entry!, ...current].slice(0, 8));
        setContent("");
        setStatus("왕국 기록에 남겼습니다.");
      } else {
        setStatus("지금은 기록을 남길 수 없습니다.");
      }
    } catch {
      setStatus("지금은 기록을 남길 수 없습니다.");
    }
  }

  return (
    <section className="guestbook-section" aria-labelledby="guestbook-title">
      <div className="guestbook-copy">
        <span className="section-index">03 / ADVENTURERS&apos; LOG</span>
        <h2 id="guestbook-title">살아남은 용사들의 기록</h2>
        <p>사기 빌드, 아슬아슬한 밤, 팀원에게 하고 싶은 말을 남겨보세요.</p>
        <form onSubmit={submit}>
          <label htmlFor="guestbook-message">방명록 메시지</label>
          <textarea
            id="guestbook-message"
            value={content}
            onChange={(event) => setContent(event.target.value.slice(0, 180))}
            placeholder={viewer ? `${viewer.displayName}의 원정 기록을 남기세요.` : "로그인 후 기록을 남길 수 있습니다."}
            disabled={!viewer}
          />
          <div><small>{content.length} / 180 · {status}</small>{viewer ? <button type="submit" disabled={content.trim().length < 2}>기록 남기기</button> : <a href="/api/auth/login?returnTo=%2F">Google로 로그인</a>}</div>
        </form>
      </div>
      <div className="guestbook-list">
        {entries.slice(0, 4).map((entry, index) => (
          <article key={entry.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{entry.authorName}</strong><p>{entry.content}</p></div>
            <time>{entry.createdAt.includes("T") ? new Date(entry.createdAt).toLocaleDateString("ko-KR") : entry.createdAt}</time>
          </article>
        ))}
      </div>
    </section>
  );
}
