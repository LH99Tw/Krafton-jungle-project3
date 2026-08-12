"use client";

import { useEffect, useState } from "react";

type CheckpointResetPanelProps = {
  currentRoomId: string;
  respawnRoomId: string;
  onConfirm: () => void;
};

function checkpointLabel(roomId: string): string {
  if (!roomId) return "시작 야영지";
  const authored = /^editor:z(\d+)-hex-(\d+)$/u.exec(roomId);
  if (authored) return `${authored[1]}구역 · ${Number(authored[2])}번 방`;
  if (roomId === "boss:arena") return "마왕의 제단";
  return roomId;
}

export function CheckpointResetPanel({ currentRoomId, respawnRoomId, onConfirm }: CheckpointResetPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const unchanged = Boolean(respawnRoomId) && respawnRoomId === currentRoomId;

  useEffect(() => setConfirming(false), [currentRoomId, respawnRoomId]);

  const confirm = () => {
    onConfirm();
    setConfirming(false);
  };

  return (
    <section className="checkpoint-reset" aria-labelledby="checkpoint-reset-title">
      <div className="checkpoint-sigil" aria-hidden="true"><i /><span>✦</span></div>
      <div className="checkpoint-copy">
        <small>SOUL ANCHOR · 개인 귀환 좌표</small>
        <h3 id="checkpoint-reset-title">부활 지점 재설정</h3>
        <p>사망 후 5초 뒤 선택한 마법진에서 다시 깨어납니다.</p>
      </div>

      <div className="checkpoint-route" aria-label="부활 지점 변경 내용">
        <div><small>현재 부활지점</small><strong>{checkpointLabel(respawnRoomId)}</strong></div>
        <span aria-hidden="true">→</span>
        <div className="is-new"><small>새로운 부활지점</small><strong>{checkpointLabel(currentRoomId)}</strong></div>
      </div>

      <p className="checkpoint-note"><span aria-hidden="true">◇</span> 이 설정은 나에게만 적용되며 파티원의 부활 위치는 바뀌지 않습니다.</p>

      {confirming ? (
        <div className="checkpoint-confirm" role="group" aria-label="부활 지점 변경 확인">
          <p>이 마법진에 영혼을 연결할까요?</p>
          <div><button type="button" onClick={() => setConfirming(false)}>취소</button><button type="button" onClick={confirm}>연결 확정</button></div>
        </div>
      ) : (
        <button type="button" className="checkpoint-reset-action" disabled={unchanged} onClick={() => setConfirming(true)}>
          {unchanged ? "현재 마법진에 연결됨" : "부활 지점 재설정"}
        </button>
      )}
    </section>
  );
}
