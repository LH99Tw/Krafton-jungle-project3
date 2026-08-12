# Web 애플리케이션

`apps/web`은 Next.js·React 접근/로비/HUD, Phaser 렌더러, 인증·세션·REST BFF, Colyseus 클라이언트를 포함한다. 온라인과 로컬 코어 세션은 같은 snapshot·특수 방 명령 계약을 사용한다.

## 실행과 검증

저장소 루트에서 실행한다.

```bash
pnpm dev:web
pnpm --filter @five-days/web lint
pnpm --filter @five-days/web typecheck
pnpm --filter @five-days/web test
pnpm --filter @five-days/web build
```

## 코드 경계

| 경로 | 책임 |
|---|---|
| `app/` | Next.js route, 인증 세션, REST API |
| `src/features/` | React 화면과 HUD |
| `src/game/client/` | Phaser 생성·asset preload |
| `src/game/runtime/` | Phaser Scene·renderer·React bridge |
| `src/game/transport/` | Colyseus·채팅·로비 전송 |
| `src/game/domain/` | UI와 런타임 공유 view model |

전체 문서는 [문서 인덱스](../../Document/README.md)를 따른다. 웹에 별도 아키텍처 명세를 두지 않는다.
