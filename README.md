# Krafton Jungle Project 3 — 《5일 뒤 마왕》

로그라이트·디펜스·RPG·타이쿤을 결합한 데스크톱 웹 게임 미니 프로젝트입니다.

## 저장소 구성

```text
apps/
└─ web/                        Phaser 3 기반 플레이 가능한 프로토타입
   ├─ app/                     웹 화면과 API
   ├─ src/features/            React UI 기능
   ├─ src/game/                게임 도메인·콘텐츠·시스템·런타임·전송 계층
   ├─ db/                      방명록·런 결과 스키마
   ├─ drizzle/                 배포 마이그레이션
   └─ tests/                   빌드 결과와 구조 스모크 테스트

Document/                    기획·설계·협업 문서
├─ 3인_개발_역할분담_보고서.md    시스템/레벨/백엔드 협업 보고서
├─ 협업_데이터_계약_초안.txt      공통 ID·명령·스냅숏 계약
├─ 게임기획서_고도화_초안.md      고도화된 게임 기획서
├─ 프로토타입_제안서.md            제작 범위와 완료 기준
└─ 기획서·추가입력 관련 원문       분석 근거 자료
```

실행법과 구현 현황은 [`apps/web/README.md`](./apps/web/README.md), 모듈 책임과 확장 경계는 [`apps/web/ARCHITECTURE.md`](./apps/web/ARCHITECTURE.md)를 참고하세요.
