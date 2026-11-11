---
type: readme
project: backend-engineering-notes
tags: [backend, api, encryption, mobile, nodejs]
status: active
last_updated: 2026-11-11
---
# Mobile API Payload Encryption

**HTTPS 위의 데이터 암호화를 고정 키·HKDF·ECDH 관점에서 비교하는 설계와 Node.js 예제**

HTTPS로 필요한 보호를 충족한다면 별도의 본문 암호화는 필수가 아닙니다. 이 주제는 **TLS 종료 지점 이후에도 특정 데이터의 원문을 제한해야 하는 경우**를 출발점으로, 비밀값의 생성·합의·보관·교체와 복호화 위치를 정리합니다.

> [!IMPORTANT]
> 실행 코드는 암호 구성 요소를 연결해 보는 **단일 프로세스 교육용 시연**입니다. 자체 핸드셰이크를 운영용 보안 프로토콜로 검증한 것이 아닙니다. 모바일 SDK, HTTPS 서버, 로그인, 실제 Redis 연결은 포함하지 않습니다.

## 문서 구성

| 파일 | 용도 |
| --- | --- |
| [mobile_api_encryption_article.md](mobile_api_encryption_article.md) | HTTPS의 보호 범위부터 세 방식과 선택 기준을 설명하는 기술 글 |
| [mobile_api_encryption_design.md](mobile_api_encryption_design.md) | 세션·메시지 형식, AAD, 재전송, Redis 및 장애 처리 설계 |
| [mobile_api_encryption_example](mobile_api_encryption_example/) | 외부 의존성이 없는 Node.js 실행 예제와 테스트 |

로컬 게시용 초안은 `mobile_api_encryption_blog.md`와 `Linkedin.md`입니다. 기존 저장소 정책에 따라 두 파일은 Git 게시 대상에서 제외합니다.

## 먼저 구분할 것

| 접근 | 해결하는 문제 | 남는 문제 |
| --- | --- | --- |
| 고정 대칭키 | 같은 키를 가진 양측의 데이터 암·복호화 | 모바일 배포본의 공통 비밀키 추출·회수·교체 |
| HKDF 파생 키 | 이미 확보한 비밀값에서 목적·방향·요청별 키 분리 | 최초 비밀값을 안전하게 확보하는 과정 |
| 인증된 ECDH | 임시 공개키 교환으로 세션 비밀값 합의 | 서버 신뢰키 배포, 사용자 인증, 세션 수명 관리 |

②와 ③은 함께 사용하는 구성 요소입니다. 예제는 **서버 서명 확인 → ECDH → HKDF → AES-GCM**을 연결합니다. 시각과 순번은 공개되어도 되는 문맥이며 비밀값의 대체물이 아닙니다. HKDF의 역할은 [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html)에 정의되어 있습니다.

## 전체 구조

```mermaid
flowchart LR
    A["모바일 앱: 본문 암호화"] -->|"HTTPS"| B["로드밸런서: TLS 종료"]
    B -->|"내부 TLS + 암호화된 본문"| C["API 서버 A · B"]
    C --> D["인증 사용자와 세션 확인"]
    D --> E["AAD · GCM 태그 검증"]
    E --> R[("Redis: 재전송 예약")]
    R --> F["인가 · 입력 검증 · 업무 처리"]
    F --> G["응답 본문 암호화"]
```

이 그림은 운영 확장 구조입니다. 실행 예제에서는 앱과 서버를 두 객체로, Redis를 메모리 저장소로 표현합니다. 별도 네트워크 요청은 발생하지 않습니다. 서버가 복호화한 뒤의 로그·DB·APM은 각각 보호해야 합니다.

## 구현한 동작과 범위

| 항목 | 예제 구현 |
| --- | --- |
| 키 합의 | 세션마다 P-256 임시 ECDH 키쌍 생성 |
| 서버 검증 | 별도로 전달한 Ed25519 검증 공개키로 핸드셰이크 서명 확인 |
| 핸드셰이크 결합 | 양측 공개키·nonce, 세션 ID, 사용자 참조값, 발급·만료 시각, 버전·suite 서명 |
| 키 유도 | ECDH 비밀값, transcript 해시, 방향·순번을 사용하는 HKDF-SHA256 |
| 본문 암호화 | AES-256-GCM, 12바이트 nonce, 16바이트 태그 |
| 송신 순번 | 방향별 채널 객체가 1부터 증가; 최대 1,000,000에서 재합의 요구 |
| AAD | 세션·사용자·방향·순번·시각 + HTTP 메서드·경로/쿼리 + 응답 상태·원요청 순번 |
| 재전송 방지 | 태그 검증 후 업무 처리 전에 `sid:direction:seq` 예약 |
| 순서 역전 | 아직 사용하지 않은 순번이면 시간 범위 내에서 허용 |
| 시간 정책 | 세션 5분, 메시지 시각 오차 ±30초; 시연용 값 |
| 입력 제한 | JSON 평문 최대 64 KiB, 정규 Base64와 정수 범위 검사 |
| 저장소 장애 | 오류·용량 부족 시 평문을 업무 처리로 반환하지 않음 |
| 검증 | 단위 및 모듈 결합 테스트 17개; 실제 분산·네트워크 테스트 아님 |

고정 공통키 방식은 위험을 비교하는 문서로만 다룹니다. 실행 예제에 앱에 넣을 공통 비밀키는 없습니다.

## 실행하기

Node.js 22 이상이 필요하며 **Node.js 24.22.1에서 검증**했습니다. 외부 패키지가 없어 `npm install` 없이 실행할 수 있습니다.

저장소 루트에서:

```bash
cd mobile_api_encryption/mobile_api_encryption_example
npm run demo
npm test
```

데모는 키·토큰·평문을 출력하지 않고 다음 결과만 표시합니다.

```text
PASS: 서버 서명 검증과 ECDH 세션 합의
PASS: HKDF 요청별 키와 AES-GCM 요청 복호화
PASS: 방향을 분리한 응답 암호화와 요청 번호 결합
PASS: 같은 암호문 재전송 거절
PASS: 변조된 암호문 거절
교육용 단일 프로세스 시연 완료. HTTP·TLS·Redis 연결은 실행하지 않았습니다.
```

서명키도 실행 때 메모리에서 생성합니다. 이것은 운영용 신뢰키 배포 구현이 아니라 **테스트용으로 신뢰 관계를 미리 설정하는 단계**입니다. 검증키는 핸드셰이크 응답에 포함하지 않습니다.

## 코드 구성

```text
mobile_api_encryption/
├── README.md
├── mobile_api_encryption_article.md
├── mobile_api_encryption_design.md
├── mobile_api_encryption_blog.md       # 로컬 게시용
├── Linkedin.md                         # 로컬 게시용
└── mobile_api_encryption_example/
    ├── package.json
    ├── session.js                     # 서명 검증과 ECDH
    ├── payload.js                     # HKDF · AES-GCM · AAD
    ├── replayStore.js                 # 단일 프로세스 중복 예약
    ├── demo.js
    └── test/encryption.test.js
```

## 실제 서비스에 연결할 때

1. TLS 종료 지점과 별도로 원문 접근을 제한할 복호화 지점을 정합니다.
2. `authenticatedUserRef`에는 서버가 검증한 사용자 식별 참조값을 넣습니다. 샘플의 `demo-user`는 로그인 구현이 아닙니다.
3. 실제 HTTP 요청·응답에서 추출한 문맥으로 AAD를 만듭니다. 암호화 패킷에 적힌 경로를 실제 라우트 대신 믿지 않습니다.
4. 같은 세션·방향의 송신 채널은 하나만 생성합니다. 채널 복제나 재시작 뒤 순번만 1로 돌리면 키·nonce를 재사용합니다. 재시작 시 새 세션을 합의합니다.
5. 메모리 저장소를 다중 서버에 그대로 사용하지 않습니다. [상세 설계](mobile_api_encryption_design.md)의 Redis 예약·상태 유실·멱등성 항목을 적용합니다.
6. 인증·인가, 요청 크기 제한, 복호화 후 입력 검증, 평문 로그 차단을 각각 연결합니다.

운영에서는 검토된 프로토콜과 라이브러리를 우선 선택해야 합니다. HPKE도 인증된 양방향 API 세션 전체를 자동 완성하지 않으며, 적용 모드·공개키의 신뢰·재전송·양방향 키 분리를 별도로 정의해야 합니다. [RFC 9180 §9.7–9.8](https://www.rfc-editor.org/rfc/rfc9180.html#section-9.7)

## 검증 범위

17개 테스트에서 정상 왕복, 신뢰키 오류, 서명·암호문·태그·메타데이터 변조, 사용자·경로·쿼리·방향·세션 불일치, 동시 재전송, 순서 역전, 시간 범위, 만료, 저장소 오류·용량 제한과 잘못된 입력을 확인했습니다.

실제 Android/iOS 호환성, 하드웨어 키 저장소, TLS 프록시, Redis 장애 조치, 성능·메모리 부하, 독립 보안 검토는 수행하지 않았습니다. 테스트 통과는 자체 프로토콜의 보안 증명이 아닙니다.

## 라이선스

이 주제를 위해 별도의 라이선스 파일은 추가하지 않았습니다.
