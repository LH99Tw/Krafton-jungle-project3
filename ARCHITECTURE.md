# 프로토타입 아키텍처

## 설계 목표

- Phaser 렌더링, React HUD, 게임 규칙, 영속 저장을 서로 분리한다.
- 첫 프로토타입은 로컬 런타임으로 완주 가능하게 만들고, 이후 동일한 명령·스냅숏 계약을 실제 멀티플레이 서버로 옮긴다.
- 클래스·특성·적·시설 수치는 콘텐츠 데이터에서 변경하며 전투 로직을 수정하지 않는다.

## 디렉터리

```text
app/
├─ api/guestbook/       방명록 읽기·쓰기
├─ api/runs/            사용자별 런 결과
├─ chatgpt-auth.ts      플랫폼 인증 경계
├─ layout.tsx           메타데이터와 한국어 문서 셸
└─ page.tsx             서버 페이지와 사용자 정보 주입

src/
├─ features/
│  ├─ game/             브리핑, HUD, 성장, 결과 React UI
│  └─ guestbook/        방명록 UI
└─ game/
   ├─ client/           Phaser 캔버스와 렌더 텍스처
   ├─ content/          클래스·특성·밸런스 데이터
   ├─ domain/           직렬화 가능한 공유 타입
   ├─ runtime/          Phaser 씬과 UI 브리지
   ├─ systems/          세션 상태기계와 성장 규칙
   └─ transport/        Local/WebSocket 교체 경계

db/
├─ schema.ts            D1 스키마
└─ index.ts             DB 바인딩 접근점
```

## 의존 방향

```text
content → domain ← systems ← runtime ← Phaser
                    ↑          ↑
                transport   React UI

DB/API ────────────────────────┘ (런 결과만)
```

`domain`, `content`, `systems`, `transport`는 React와 DB를 import하지 않습니다. React는 게임 상태를 직접 수정하지 않고 `GameBridge`에 명령을 전송합니다. HUD는 60fps 월드 전체가 아니라 120ms 간격의 작은 스냅숏만 구독합니다.

## 멀티플레이 확장

현재 `LocalTransport` 대신 `WebSocketTransport`를 추가하고 다음 순서로 서버 권위화를 진행합니다.

1. `GameCommand`를 네트워크 메시지로 직렬화
2. 시간·피해·골드·드롭·건설을 서버에서 판정
3. 서버가 `GameSnapshot` 또는 상태 패치를 전송
4. 클라이언트는 이동을 예측하고 서버 상태로 보간
5. Phaser 씬의 순수 규칙을 `packages/game-core`로 추출
6. 별도 `apps/game-server` 또는 Durable Object가 같은 규칙 패키지를 사용

PostgreSQL 또는 D1은 계정·메타 성장·방명록·런 결과만 저장합니다. 실시간 엔티티 위치와 탄막은 게임 룸 메모리에서 처리합니다.

## 콘텐츠 확장

- 클래스 추가: `content/classes.ts`와 전용 특성을 추가하고 스킬 전략을 런타임 레지스트리에 연결
- 적 추가: `content/balance.ts`의 원형과 스폰 전략 추가
- 장비: `domain`에 장비 정의와 인벤토리 스냅숏을 추가하되 효과는 성장 수정자로 합성
- 맵: 현재 고정 골격을 방 템플릿과 시드 생성기로 교체
- 자유 건설: 현재 그리드 검증에 경로 유효성 검사와 서버 승인 추가

## 성능 규칙

- Phaser가 월드 상태와 60fps 업데이트를 소유한다.
- React에는 HUD와 모달에 필요한 값만 전달한다.
- 투사체는 풀을 재사용하고 수명을 제한한다.
- 비활성 탭 복귀 시 한 프레임 델타를 100ms로 제한한다.
- 씬 종료 시 명령 구독과 입력 리스너를 해제한다.

