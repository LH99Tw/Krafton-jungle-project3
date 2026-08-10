"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { LobbyChatMessage, LobbyListing } from "@five-days/protocol";
import type { LobbySnapshot } from "@/src/game/transport/LobbyTransport";
import type { Viewer } from "../game/GameShell";
import { FantasyButton } from "../../components/ui/FantasyButton";
import { FantasyFrame } from "../../components/ui/FantasyFrame";
import { FantasySectionHeading } from "../../components/ui/FantasySectionHeading";

export function LobbyScreen({ viewer, rooms, snapshot, messages, busy, error, onCreate, onJoin, onLeave, onReady, onStart, onOfflineStart, onChat, onAddAi, onRemoveAi, onBack }: {
  viewer: NonNullable<Viewer>;
  rooms: LobbyListing[];
  snapshot: LobbySnapshot | null;
  messages: LobbyChatMessage[];
  busy: boolean;
  error: string;
  onCreate: (input: { roomName: string; sessionMode: "prototype" | "full"; difficulty: "easy" | "normal" | "hard" }) => Promise<void>;
  onJoin: (roomId: string) => Promise<void>;
  onLeave: () => Promise<void>;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  onOfflineStart?: () => void;
  onChat: (message: string) => void;
  onAddAi: () => void;
  onRemoveAi: (userId: string) => void;
  onBack: () => void;
}) {
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [chat, setChat] = useState("");
  const me = snapshot?.players.find((player) => player.userId === viewer.userId);
  const allReady = snapshot?.players.length === 3 && snapshot.players.every((player) => player.ready && player.connected);
  const selectedRoom = useMemo(() => rooms.find((room) => room.roomId === selectedRoomId) ?? null, [rooms, selectedRoomId]);

  function submitChat(event: FormEvent) {
    event.preventDefault();
    const value = chat.trim();
    if (!value) return;
    onChat(value);
    setChat("");
  }

  return (
    <main className="lobby-screen">
      <header className="operation-bar">
        <button className="operation-brand" type="button" onClick={onBack}><span aria-hidden="true">†</span><strong>5일 뒤 마왕</strong></button>
        <div className="operation-title"><i aria-hidden="true" />원정대 집결지<i aria-hidden="true" /></div>
        <div className="operator-id"><small>{viewer.accountType === "guest" ? "방문 용사" : "계정 용사"}</small><strong>{viewer.displayName}</strong></div>
      </header>

      <div className="lobby-workspace">
        <section className="chat-column" aria-labelledby="chat-title">
          <FantasyFrame className="lobby-panel-ornament" aria-hidden="true" />
          <FantasySectionHeading id="chat-title" title="원정대 대화" description={snapshot ? snapshot.roomName : "원정대에 참가하면 열립니다"} />
          <div className="chat-log" aria-live="polite">
            {!snapshot ? <p className="empty-copy">선택한 원정대의 통신만 표시됩니다.</p> : messages.length === 0 ? <p className="empty-copy">첫 작전 메시지를 남겨보세요.</p> : messages.map((message) => (
              <div className={message.userId === viewer.userId ? "chat-line is-mine" : "chat-line"} key={message.id}><span>{message.displayName}<time>{new Date(message.sentAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time></span><p>{message.message}</p></div>
            ))}
          </div>
          <form className="chat-compose" onSubmit={submitChat}><label className="sr-only" htmlFor="party-chat">파티 메시지</label><input id="party-chat" value={chat} onChange={(event) => setChat(event.target.value)} disabled={!snapshot} maxLength={180} placeholder={snapshot ? "메시지 입력" : "방 참가 필요"} /><FantasyButton variant="quiet" size="small" type="submit" disabled={!snapshot || !chat.trim()}>전송</FantasyButton></form>
        </section>

        <section className="room-column" aria-labelledby="room-title">
          <FantasyFrame className="lobby-panel-ornament" aria-hidden="true" />
          <div className="room-title-row"><FantasySectionHeading id="room-title" level={1} title="모집 중인 원정대" description="함께할 동료를 찾거나 새로운 원정대를 꾸리세요" action={<FantasyButton className="create-room-button" variant="secondary" size="small" type="button" disabled={!!snapshot} onClick={() => setCreateOpen(true)}>새 원정대</FantasyButton>} /></div>
          <div className="room-table" role="listbox" aria-label="공개 방 목록">
            <div className="room-table-head"><span>작전실</span><span>세션</span><span>난이도</span><span>인원</span></div>
            <div className="room-list-scroll">
              {rooms.length === 0 ? (
                <div className="room-empty">
                  <strong>열린 원정대가 없습니다.</strong>
                  <span>혼자 싱글 원정을 시작하거나 새 원정대를 꾸리세요.</span>
                  {onOfflineStart ? (
                    <div style={{ marginTop: "16px" }}>
                      <FantasyButton variant="primary" size="large" type="button" onClick={onOfflineStart}>
                        ⚔️ 혼자 바로 원정 시작하기
                      </FantasyButton>
                    </div>
                  ) : null}
                </div>
              ) : rooms.map((room, index) => (
                <button className={`${selectedRoomId === room.roomId ? "is-selected" : ""} ${snapshot?.roomId === room.roomId ? "is-current" : ""}`} type="button" role="option" aria-selected={selectedRoomId === room.roomId} key={room.roomId} onClick={() => !snapshot && setSelectedRoomId(room.roomId)}>
                  <span><i>{String(index + 1).padStart(2, "0")}</i><strong>{room.roomName}</strong><small>{room.phase === "waiting" ? "모집 중" : room.phase === "selecting" ? "선택 중" : "게임 중"}</small></span>
                  <span>{room.sessionMode === "prototype" ? "8분" : "25분"}</span>
                  <span>{difficultyLabel(room.difficulty)}</span>
                  <span className="room-count"><b>{room.clients}</b> / {room.maxClients}</span>
                </button>
              ))}
            </div>
          </div>
          {!snapshot ? <div className="room-join-strip"><div><small>선택한 원정대</small><strong>{selectedRoom?.roomName ?? "원정대를 선택하세요"}</strong></div><FantasyButton variant="secondary" size="large" type="button" disabled={!selectedRoom || selectedRoom.clients >= 3 || selectedRoom.phase !== "waiting" || busy} onClick={() => selectedRoom && void onJoin(selectedRoom.roomId)} trailingIcon="›">합류하기</FantasyButton></div> : null}
        </section>

        <aside className="party-column" aria-labelledby="party-title">
          <FantasyFrame className="lobby-panel-ornament" aria-hidden="true" />
          <FantasySectionHeading id="party-title" title="나의 원정대" description={snapshot ? `${snapshot.players.length} / 3명 합류` : "아직 소속된 원정대가 없습니다"} />
          <div className="party-roster">
            {[0, 1, 2].map((slot) => {
              const player = snapshot?.players[slot];
              return player ? <div className={`party-member ${player.isAi ? "is-ai" : ""}`} key={player.userId}><div>{player.displayName.slice(0, 1)}</div><span><strong>{player.displayName}{snapshot?.hostId === player.userId ? <em>방장</em> : null}{player.isAi ? <em>AI 동료</em> : null}</strong><small>{player.isAi ? "자동 전투 지원" : player.connected ? player.ready ? "준비 완료" : "준비 중" : "재접속 대기"}</small></span>{player.isAi && snapshot?.hostId === viewer.userId && snapshot.phase === "waiting" ? <button className="remove-ai" type="button" onClick={() => onRemoveAi(player.userId)} aria-label={`${player.displayName} AI 제외`}>×</button> : <i className={player.ready ? "is-ready" : ""} />}</div> : <div className="party-member is-empty" key={slot}><div>+</div><span><strong>빈자리</strong><small>동료를 기다리는 중</small></span>{snapshot?.hostId === viewer.userId ? <button className="add-ai" type="button" onClick={onAddAi}>AI 동료</button> : null}</div>;
            })}
          </div>
          {snapshot ? <dl className="party-settings"><div><dt>세션</dt><dd>{snapshot.sessionMode === "prototype" ? "프로토타입 · 8분" : "정식 흐름 · 25분"}</dd></div><div><dt>난이도</dt><dd>{difficultyLabel(snapshot.difficulty)}</dd></div></dl> : <p className="party-instruction">방을 만들거나 참가하면 이곳에서 준비 상태와 출전 조건을 확인할 수 있습니다.</p>}
          {error ? <p className="surface-error" role="alert">{error}</p> : null}
          <div className="party-actions">
            {snapshot ? <>
              <FantasyButton className="leave-room" variant="danger" type="button" onClick={() => void onLeave()} disabled={busy}>퇴장</FantasyButton>
              <FantasyButton className="ready-button" variant="secondary" type="button" onClick={() => onReady(!me?.ready)}>{me?.ready ? "준비 취소" : "준비"}</FantasyButton>
              {snapshot.hostId === viewer.userId ? <FantasyButton className="start-select-button" variant="primary" type="button" disabled={!allReady} onClick={onStart}>캐릭터 선택 시작</FantasyButton> : <span className="leader-wait">방장의 시작을 기다리는 중</span>}
            </> : null}
          </div>
        </aside>
      </div>

      {createOpen ? <CreateRoomDialog busy={busy} onClose={() => setCreateOpen(false)} onCreate={async (input) => { await onCreate(input); setCreateOpen(false); }} /> : null}
    </main>
  );
}

function CreateRoomDialog({ busy, onClose, onCreate }: { busy: boolean; onClose: () => void; onCreate: (input: { roomName: string; sessionMode: "prototype" | "full"; difficulty: "easy" | "normal" | "hard" }) => Promise<void> }) {
  const [roomName, setRoomName] = useState("");
  const [sessionMode, setSessionMode] = useState<"prototype" | "full">("prototype");
  const [difficulty, setDifficulty] = useState<"easy" | "normal" | "hard">("normal");
  return <div className="create-backdrop" role="dialog" aria-modal="true" aria-labelledby="create-title"><form className="create-dialog" onSubmit={(event) => { event.preventDefault(); void onCreate({ roomName: roomName.trim(), sessionMode, difficulty }); }}><span>새로운 여정의 시작</span><h2 id="create-title">원정대 편성</h2><label>원정대 이름<input value={roomName} maxLength={24} minLength={2} required onChange={(event) => setRoomName(event.target.value)} placeholder="예: 새벽의 원정대" /></label><fieldset><legend>원정 시간</legend><FantasyButton type="button" variant={sessionMode === "prototype" ? "primary" : "quiet"} className={sessionMode === "prototype" ? "active" : ""} onClick={() => setSessionMode("prototype")}>짧은 원정 <small>8분</small></FantasyButton><FantasyButton type="button" variant={sessionMode === "full" ? "primary" : "quiet"} className={sessionMode === "full" ? "active" : ""} onClick={() => setSessionMode("full")}>긴 원정 <small>25분</small></FantasyButton></fieldset><fieldset><legend>난이도</legend>{(["easy", "normal", "hard"] as const).map((value) => <FantasyButton key={value} type="button" variant={difficulty === value ? "primary" : "quiet"} className={difficulty === value ? "active" : ""} onClick={() => setDifficulty(value)}>{difficultyLabel(value)}</FantasyButton>)}</fieldset><div><FantasyButton type="button" variant="quiet" onClick={onClose}>돌아가기</FantasyButton><FantasyButton type="submit" variant="primary" disabled={busy || roomName.trim().length < 2}>원정대 만들기</FantasyButton></div></form></div>;
}

function difficultyLabel(value: "easy" | "normal" | "hard") { return value === "easy" ? "쉬움" : value === "normal" ? "보통" : "어려움"; }
