"use strict";

const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { createClientHandshake, acceptClientHandshake } = require("./session");
const { createChannel } = require("./payload");
const { createMemoryReplayStore } = require("./replayStore");

async function main() {
    // 교육용 신뢰 설정: 네트워크 응답에서 검증키를 가져오지 않는다.
    // 운영의 서명키는 서버의 비밀 관리 체계에서 주입하고 검증 공개키는 별도로 배포한다.
    const serverIdentity = crypto.generateKeyPairSync("ed25519");
    const trustedServerPublicKey = serverIdentity.publicKey;
    const authenticatedUserRef = "demo-user";
    const handshake = createClientHandshake();
    const accepted = acceptClientHandshake(handshake.hello, serverIdentity.privateKey, authenticatedUserRef);
    const clientSession = handshake.complete(accepted.reply, trustedServerPublicKey, authenticatedUserRef);
    const client = createChannel(clientSession, "client", createMemoryReplayStore());
    const server = createChannel(accepted.session, "server", createMemoryReplayStore());
    clientSession.secret.fill(0);
    accepted.session.secret.fill(0);

    try {
        const requestContext = { method: "POST", target: "/api/example", status: 0, requestSeq: 0 };
        const request = client.seal({ message: "암호화 흐름 확인" }, requestContext);
        const decoded = await server.open(request, requestContext, authenticatedUserRef);
        assert.equal(decoded.message, "암호화 흐름 확인");
        console.log("PASS: 서버 서명 검증과 ECDH 세션 합의");
        console.log("PASS: HKDF 요청별 키와 AES-GCM 요청 복호화");

        const responseContext = { ...requestContext, status: 200, requestSeq: request.seq };
        const response = server.seal({ ok: true }, responseContext);
        assert.deepEqual(await client.open(response, responseContext, authenticatedUserRef), { ok: true });
        console.log("PASS: 방향을 분리한 응답 암호화와 요청 번호 결합");

        await assert.rejects(server.open(request, requestContext, authenticatedUserRef), /REPLAY_DETECTED/);
        console.log("PASS: 같은 암호문 재전송 거절");

        const next = client.seal({ message: "변조 검증" }, requestContext);
        const changed = Buffer.from(next.data, "base64");
        changed[0] ^= 1;
        await assert.rejects(
            server.open({ ...next, data: changed.toString("base64") }, requestContext, authenticatedUserRef),
            /INVALID_PACKET/
        );
        console.log("PASS: 변조된 암호문 거절");
        console.log("교육용 단일 프로세스 시연 완료. HTTP·TLS·Redis 연결은 실행하지 않았습니다.");
    } finally {
        client.close();
        server.close();
    }
}

main().catch(() => {
    console.error("DEMO_FAILED");
    process.exitCode = 1;
});
