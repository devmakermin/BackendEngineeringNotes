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
| [모바일 API 데이터 암호화](mobile_api_encryption/README.md) | HTTPS 보호 경계, 고정 키·HKDF·ECDH 비교, AES-GCM과 재전송 방지 | [Node.js 암호화 샘플](mobile_api_encryption/mobile_api_encryption_example/) |
| [클라이언트 네트워크 SDK](client_network_sdk/README.md) | 서버팀의 Unity 통신 모듈 개발 경험, 요청별 결과와 패킷 ID별 JSON 저장 | [C# + 로컬 HTTP 샘플](client_network_sdk/client_network_sdk_example/) |

첫 번째 예제는 Lua 없이 `WATCH`와 `MULTI/EXEC`를 사용합니다. 설치·실행·검증 방법과 운영 한계는 주제별 README에 정리합니다.

블로그·LinkedIn 초안과 로컬 검토 기록은 GitHub 게시 대상에서 제외합니다.
