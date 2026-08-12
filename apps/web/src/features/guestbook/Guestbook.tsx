"use client";

import Image from "next/image";
import { FormEvent, PointerEvent, useEffect, useRef, useState } from "react";
import type { Viewer } from "../game/GameShell";

type Entry = {
  id: string;
  authorName: string;
  content: string;
  positionX: number;
  positionY: number;
  createdAt: string;
  updatedAt: string;
};

type EditorState = {
  mode: "create" | "edit";
  id?: string;
  authorName: string;
  content: string;
  password: string;
};

const EMPTY_EDITOR: EditorState = { mode: "create", authorName: "", content: "", password: "" };
const NOTE_MIN = 76;
const NOTE_MAX = 924;

export function Guestbook({ viewer }: { viewer: Viewer }) {
  const boardRef = useRef<HTMLDivElement>(null);
  const passwordsRef = useRef(new Map<string, string>());
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    originalX: number;
    originalY: number;
  } | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [status, setStatus] = useState("방명록을 불러오는 중…");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async (quiet = false) => {
      try {
        const response = await fetch("/api/guestbook", { cache: "no-store" });
        const payload = await readPayload<{ entries?: Entry[] }>(response);
        if (!response.ok) throw new Error("방명록을 불러오지 못했습니다.");
        if (active && !dragRef.current) setEntries(payload.entries ?? []);
        if (active && !quiet) setStatus("");
      } catch {
        if (active && !quiet) setStatus("방명록 연결을 확인해 주세요.");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(true), 4_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  function openCreate() {
    setEditor({ ...EMPTY_EDITOR, authorName: viewer?.displayName ?? "" });
    setStatus("");
  }

  function openEdit(entry: Entry) {
    setEditor({
      mode: "edit",
      id: entry.id,
      authorName: entry.authorName,
      content: entry.content,
      password: passwordsRef.current.get(entry.id) ?? "",
    });
    setStatus("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || editor.content.trim().length < 2 || editor.password.length < 4) return;
    setSaving(true);
    setStatus("메모를 붙이는 중…");
    const editing = editor.mode === "edit" && editor.id;
    const position = nextPosition(entries.length);
    try {
      const response = await fetch("/api/guestbook", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editing
          ? { id: editor.id, authorName: editor.authorName, content: editor.content, password: editor.password }
          : { authorName: editor.authorName, content: editor.content, password: editor.password, ...position }),
      });
      const payload = await readPayload<{ entry?: Entry; error?: { message?: string } }>(response);
      if (!response.ok || !payload.entry) throw new Error(payload.error?.message ?? "메모를 저장하지 못했습니다.");
      setEntries((current) => editing
        ? current.map((entry) => entry.id === payload.entry!.id ? payload.entry! : entry)
        : [...current, payload.entry!]);
      savePassword(payload.entry.id, editor.password);
      setEditor(null);
      setStatus("메모가 모두에게 공개되었습니다.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "메모를 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(entry: Entry) {
    const password = passwordFor(entry.id, "삭제하려면 메모 비밀번호 또는 마스터키를 입력해 주세요.");
    if (!password) return;
    if (!window.confirm(`“${entry.content.slice(0, 32)}${entry.content.length > 32 ? "…" : ""}” 메모를 정말 떼어낼까요?`)) return;
    const previous = entries;
    setEntries((current) => current.filter((candidate) => candidate.id !== entry.id));
    setStatus("메모를 떼는 중…");
    try {
      const response = await fetch("/api/guestbook", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: entry.id, password }),
      });
      const payload = await readPayload<{ error?: { message?: string } }>(response);
      if (!response.ok && response.status !== 404) throw new Error(payload.error?.message ?? "메모를 삭제하지 못했습니다.");
      savePassword(entry.id, password);
      setStatus("메모를 삭제했습니다.");
    } catch (error) {
      setEntries(previous);
      setStatus(error instanceof Error ? error.message : "메모를 삭제하지 못했습니다.");
    }
  }

  function beginDrag(event: PointerEvent<HTMLElement>, entry: Entry) {
    if ((event.target as HTMLElement).closest("button")) return;
    const board = boardRef.current;
    if (!board) return;
    const rect = board.getBoundingClientRect();
    dragRef.current = {
      id: entry.id,
      pointerId: event.pointerId,
      offsetX: event.clientX - (rect.left + entry.positionX / 1000 * rect.width),
      offsetY: event.clientY - (rect.top + entry.positionY / 1000 * rect.height),
      originalX: entry.positionX,
      originalY: entry.positionY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-dragging");
  }

  function moveDrag(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    const board = boardRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !board) return;
    const rect = board.getBoundingClientRect();
    const positionX = clamp(Math.round((event.clientX - drag.offsetX - rect.left) / rect.width * 1000), NOTE_MIN, NOTE_MAX);
    const positionY = clamp(Math.round((event.clientY - drag.offsetY - rect.top) / rect.height * 1000), NOTE_MIN, NOTE_MAX);
    setEntries((current) => current.map((entry) => entry.id === drag.id ? { ...entry, positionX, positionY } : entry));
  }

  function endDrag(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.classList.remove("is-dragging");
    const entry = entries.find((candidate) => candidate.id === drag.id);
    if (entry) void persistPosition(entry, drag.originalX, drag.originalY);
  }

  async function persistPosition(entry: Entry, originalX: number, originalY: number) {
    const password = passwordFor(entry.id, "위치를 저장하려면 메모 비밀번호 또는 마스터키를 입력해 주세요.");
    if (!password) {
      restorePosition(entry.id, originalX, originalY);
      return;
    }
    try {
      const response = await fetch("/api/guestbook", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: entry.id, password, positionX: entry.positionX, positionY: entry.positionY }),
      });
      const payload = await readPayload<{ error?: { message?: string } }>(response);
      if (!response.ok) throw new Error(payload.error?.message ?? "위치를 저장하지 못했습니다.");
      savePassword(entry.id, password);
      setStatus("새 위치를 저장했습니다.");
    } catch (error) {
      restorePosition(entry.id, originalX, originalY);
      setStatus(error instanceof Error ? error.message : "위치를 저장하지 못했습니다. 다시 움직여 주세요.");
    }
  }

  function restorePosition(id: string, positionX: number, positionY: number) {
    setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, positionX, positionY } : entry));
  }

  function passwordFor(id: string, promptMessage: string): string | null {
    const stored = passwordsRef.current.get(id);
    if (stored) return stored;
    const password = window.prompt(promptMessage);
    return password && password.length >= 4 && password.length <= 128 ? password : null;
  }

  function savePassword(id: string, password: string) {
    passwordsRef.current.set(id, password);
  }

  return (
    <div className="guestbook-layer">
      <button className="guestbook-trigger" type="button" onClick={openCreate} aria-label="방명록 메모 작성">
        <Image src="/images/ui/guestbook/guestbook-icon.webp" alt="" width={320} height={320} priority />
        <span>방명록</span>
        <small>{entries.length}개의 메모</small>
      </button>

      <div className="guestbook-board" ref={boardRef} aria-live="polite">
        {entries.map((entry, index) => (
          <article
            className="guestbook-note"
            key={entry.id}
            style={{
              left: `${entry.positionX / 10}%`,
              top: `${entry.positionY / 10}%`,
              rotate: `${noteRotation(entry.id)}deg`,
              zIndex: index + 2,
            }}
            onPointerDown={(event) => beginDrag(event, entry)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <i aria-hidden="true" />
            <p>{entry.content}</p>
            <footer>
              <strong>{entry.authorName}</strong>
              <span>
                <button type="button" onClick={() => openEdit(entry)}>수정</button>
                <button type="button" onClick={() => void remove(entry)}>삭제</button>
              </span>
            </footer>
          </article>
        ))}
      </div>

      <p className={`guestbook-status${status ? " is-visible" : ""}`} role="status">{status}</p>

      {editor ? (
        <div className="guestbook-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) setEditor(null);
        }}>
          <section className="guestbook-dialog" role="dialog" aria-modal="true" aria-labelledby="guestbook-dialog-title">
            <button className="guestbook-close" type="button" onClick={() => setEditor(null)} aria-label="닫기">×</button>
            <h2 id="guestbook-dialog-title">방명록</h2>
            <form onSubmit={submit}>
              <label htmlFor="guestbook-author">이름</label>
              <input
                id="guestbook-author"
                value={editor.authorName}
                onChange={(event) => setEditor({ ...editor, authorName: event.target.value.slice(0, 24) })}
                placeholder="익명의 방문자"
                autoComplete="nickname"
              />
              <label htmlFor="guestbook-password">
                {editor.mode === "edit" ? "메모 비밀번호 또는 마스터키" : "메모 비밀번호"}
              </label>
              <input
                id="guestbook-password"
                type="password"
                value={editor.password}
                onChange={(event) => setEditor({ ...editor, password: event.target.value.slice(0, editor.mode === "edit" ? 128 : 24) })}
                minLength={4}
                maxLength={editor.mode === "edit" ? 128 : 24}
                autoComplete={editor.mode === "create" ? "new-password" : "current-password"}
                required
              />
              <label htmlFor="guestbook-content">메시지</label>
              <textarea
                id="guestbook-content"
                value={editor.content}
                onChange={(event) => setEditor({ ...editor, content: event.target.value.slice(0, 180) })}
                placeholder="이곳을 다녀간 흔적을 남겨주세요."
                minLength={2}
                maxLength={180}
                required
              />
              <div className="guestbook-dialog-footer">
                <small>{editor.content.length} / 180</small>
                <button type="submit" disabled={saving || editor.content.trim().length < 2 || editor.password.length < 4}>
                  {saving ? "붙이는 중…" : editor.mode === "create" ? "화면에 붙이기" : "수정 완료"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function nextPosition(count: number) {
  const column = count % 5;
  const row = Math.floor(count / 5) % 3;
  return {
    positionX: clamp(160 + column * 165 + (row % 2) * 32, NOTE_MIN, NOTE_MAX),
    positionY: clamp(180 + row * 270 + (column % 2) * 38, NOTE_MIN, NOTE_MAX),
  };
}

function noteRotation(id: string) {
  return ((id.charCodeAt(0) + id.charCodeAt(id.length - 1)) % 7) - 3;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

async function readPayload<T>(response: Response): Promise<T> {
  const text = await response.text();
  return text ? JSON.parse(text) as T : {} as T;
}
