---
type: readme
project: backend-engineering-notes
tags: [backend, api, redis]
status: active
---
# Backend Engineering Notes

서버 개발 과정에서 다룬 기술 주제의 설계와 실행 가능한 예제를 정리합니다.

| 주제 | 내용 | 코드 |
| --- | --- | --- |
| [행동 기반 API 남용 탐지](behavioral_guard/README.md) | IP·검증된 계정, 여러 시간 창, 위험 점수, Redis 공유 제재 | [Node.js + Redis 샘플](behavioral_guard/behavioral_guard_example/) |

첫 번째 예제는 Lua 없이 `WATCH`와 `MULTI/EXEC`를 사용합니다. 설치·실행·검증 방법과 운영 한계는 주제별 README에 정리합니다.

블로그·LinkedIn 초안과 로컬 검토 기록은 GitHub 게시 대상에서 제외합니다.
