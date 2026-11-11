"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createClientHandshake, acceptClientHandshake, SESSION_LIFETIME_MS } = require("../session");
const { createChannel, MAX_PAYLOAD_BYTES } = require("../payload");
const { createMemoryReplayStore } = require("../replayStore");

const START_TIME = 1_800_000_000_000;
const USER_REF = "test-user";
const REQUEST = Object.freeze({ method: "POST", target: "/api/example?mode=test", status: 0, requestSeq: 0 });

function handshakeFixture() {
    const identity = crypto.generateKeyPairSync("ed25519");
    const handshake = createClientHandshake();
    const accepted = acceptClientHandshake(handshake.hello, identity.privateKey, USER_REF, START_TIME);
    return { identity, handshake, accepted };
}

function channelFixture(store = createMemoryReplayStore()) {
    const setup = handshakeFixture();
    let now = START_TIME;
    const clock = () => now;
    const clientSession = setup.handshake.complete(setup.accepted.reply, setup.identity.publicKey, USER_REF, now);
    const client = createChannel(clientSession, "client", createMemoryReplayStore(), clock);
    const server = createChannel(setup.accepted.session, "server", store, clock);
    clientSession.secret.fill(0);
    setup.accepted.session.secret.fill(0);
    return { client, server, setTime: (value) => { now = value; } };
}

function flipBase64(value) {
    const bytes = Buffer.from(value, "base64");
    bytes[0] ^= 1;
    return bytes.toString("base64");
}

test("별도 신뢰 공개키로 서명을 검증하고 양측이 같은 세션 비밀값을 얻는다", () => {
    const { identity, handshake, accepted } = handshakeFixture();
    const client = handshake.complete(accepted.reply, identity.publicKey, USER_REF, START_TIME);
    assert.deepEqual(client.secret, accepted.session.secret);
    assert.deepEqual(client.salt, accepted.session.salt);
    assert.throws(() => handshake.complete(accepted.reply, identity.publicKey, USER_REF, START_TIME));
});

test("응답의 공개키를 신뢰하지 않고 잘못된 신뢰키를 거절한다", () => {
    const { handshake, accepted } = handshakeFixture();
    const impostor = crypto.generateKeyPairSync("ed25519");
    assert.throws(() => handshake.complete(accepted.reply, impostor.publicKey, USER_REF, START_TIME));
});

test("서명 대상의 세션·사용자·시각·공개키·nonce 변조를 거절한다", () => {
    const { identity, handshake, accepted } = handshakeFixture();
    const edits = [
        { v: 2 }, { suite: "unknown" }, { sid: "0".repeat(32) }, { userRef: "other-user" },
        { issuedAt: START_TIME + 1, expiresAt: START_TIME + 1 + SESSION_LIFETIME_MS },
        { clientPublicKey: flipBase64(accepted.reply.clientPublicKey) },
        { clientNonce: flipBase64(accepted.reply.clientNonce) },
        { serverPublicKey: flipBase64(accepted.reply.serverPublicKey) },
        { serverNonce: flipBase64(accepted.reply.serverNonce) },
        { signature: flipBase64(accepted.reply.signature) }
    ];
    for (const edit of edits) {
        assert.throws(() => handshake.complete({ ...accepted.reply, ...edit }, identity.publicKey, USER_REF, START_TIME));
    }
});

test("오래된 핸드셰이크와 곡선 밖의 클라이언트 공개키를 거절한다", () => {
    const { identity, handshake, accepted } = handshakeFixture();
    assert.throws(() => handshake.complete(accepted.reply, identity.publicKey, USER_REF, START_TIME + 30_001));
    assert.throws(() => acceptClientHandshake(
        { ...handshake.hello, clientPublicKey: Buffer.alloc(65).toString("base64") },
        identity.privateKey, USER_REF, START_TIME
    ));
});

test("한글 JSON 요청과 요청에 연결된 응답을 왕복 암호화한다", async () => {
    const { client, server } = channelFixture();
    const value = { message: "한글 데이터", items: [1, true, null] };
    const packet = client.seal(value, REQUEST);
    assert.deepEqual(await server.open(packet, REQUEST, USER_REF), value);
    const context = { ...REQUEST, status: 200, requestSeq: packet.seq };
    const response = server.seal({ ok: true }, context);
    assert.deepEqual(await client.open(response, context, USER_REF), { ok: true });
});

test("동일 평문에도 순번별 암호문이 다르고 요청 순서 역전을 허용한다", async () => {
    const { client, server } = channelFixture();
    const first = client.seal({ value: 1 }, REQUEST);
    const second = client.seal({ value: 1 }, REQUEST);
    assert.notEqual(first.seq, second.seq);
    assert.notEqual(first.data, second.data);
    assert.deepEqual(await server.open(second, REQUEST, USER_REF), { value: 1 });
    assert.deepEqual(await server.open(first, REQUEST, USER_REF), { value: 1 });
});

test("암호문·태그·인증 메타데이터 변조는 순번을 소비하지 않는다", async () => {
    const { client, server } = channelFixture();
    const packet = client.seal({ value: 1 }, REQUEST);
    const edits = [
        { data: flipBase64(packet.data) }, { tag: flipBase64(packet.tag) }, { ts: packet.ts + 1 },
        { seq: packet.seq + 1 }, { sid: "0".repeat(32) }, { direction: "s2c" }, { v: 2 }
    ];
    for (const edit of edits) {
        await assert.rejects(server.open({ ...packet, ...edit }, REQUEST, USER_REF), /INVALID_PACKET/);
    }
    assert.deepEqual(await server.open(packet, REQUEST, USER_REF), { value: 1 });
});

test("HTTP 메서드·경로·쿼리를 바꾸거나 다른 사용자로 복호화하면 거절한다", async () => {
    const { client, server } = channelFixture();
    const packet = client.seal({ value: 1 }, REQUEST);
    for (const edit of [{ method: "PUT" }, { target: "/api/other" }, { target: "/api/example?mode=admin" }]) {
        await assert.rejects(server.open(packet, { ...REQUEST, ...edit }, USER_REF), /INVALID_PACKET/);
    }
    await assert.rejects(server.open(packet, REQUEST, "other-user"), /USER_MISMATCH/);
    assert.deepEqual(await server.open(packet, REQUEST, USER_REF), { value: 1 });
});

test("응답의 상태코드·원요청 번호를 변경하거나 방향을 반사하면 거절한다", async () => {
    const { client, server } = channelFixture();
    const context = { ...REQUEST, status: 200, requestSeq: 1 };
    const response = server.seal({ ok: true }, context);
    await assert.rejects(client.open(response, { ...context, status: 201 }, USER_REF), /INVALID_PACKET/);
    await assert.rejects(client.open(response, { ...context, requestSeq: 2 }, USER_REF), /INVALID_PACKET/);
    const request = client.seal({ ok: true }, REQUEST);
    await assert.rejects(client.open({ ...request, direction: "s2c" }, context, USER_REF), /INVALID_PACKET/);
    assert.deepEqual(await client.open(response, context, USER_REF), { ok: true });
});

test("다른 세션의 암호문을 수신 세션에 옮길 수 없다", async () => {
    const first = channelFixture();
    const second = channelFixture();
    const packet = first.client.seal({ value: 1 }, REQUEST);
    await assert.rejects(second.server.open(packet, REQUEST, USER_REF), /INVALID_PACKET/);
});

test("동일 암호문 20개 동시 수신 중 하나만 업무 처리로 반환한다", async () => {
    const { client, server } = channelFixture();
    const packet = client.seal({ value: 1 }, REQUEST);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => server.open(packet, REQUEST, USER_REF)));
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected" && item.reason.message === "REPLAY_DETECTED").length, 19);
});

test("오래되거나 미래 허용 범위를 넘는 패킷과 만료 세션을 거절한다", async () => {
    const fixture = channelFixture();
    const packet = fixture.client.seal({ value: 1 }, REQUEST);
    fixture.setTime(START_TIME + 30_001);
    await assert.rejects(fixture.server.open(packet, REQUEST, USER_REF), /STALE_PACKET/);
    fixture.setTime(START_TIME + SESSION_LIFETIME_MS);
    await assert.rejects(fixture.server.open(packet, REQUEST, USER_REF), /SESSION_EXPIRED/);
    assert.throws(() => fixture.client.seal({}, REQUEST), /SESSION_EXPIRED/);
    const future = channelFixture();
    future.setTime(START_TIME + 30_001);
    const futurePacket = future.client.seal({}, REQUEST);
    future.setTime(START_TIME);
    await assert.rejects(future.server.open(futurePacket, REQUEST, USER_REF), /STALE_PACKET/);
});

test("저장소 장애·용량 초과 시 요청을 허용하지 않는다", async () => {
    const failing = channelFixture({ claim: async () => { throw new Error("STORE_UNAVAILABLE"); } });
    const packet = failing.client.seal({}, REQUEST);
    await assert.rejects(failing.server.open(packet, REQUEST, USER_REF), /STORE_UNAVAILABLE/);
    const full = channelFixture(createMemoryReplayStore({ maxEntries: 1 }));
    await full.server.open(full.client.seal({}, REQUEST), REQUEST, USER_REF);
    await assert.rejects(full.server.open(full.client.seal({}, REQUEST), REQUEST, USER_REF), /REPLAY_STORE_FULL/);
});

test("재전송 저장소 대기 중 세션이 만료되면 평문을 반환하지 않는다", async () => {
    let fixture;
    fixture = channelFixture({ claim: async () => { fixture.setTime(START_TIME + SESSION_LIFETIME_MS); return true; } });
    await assert.rejects(fixture.server.open(fixture.client.seal({}, REQUEST), REQUEST, USER_REF), /SESSION_EXPIRED/);
});

test("메모리 재전송 표식은 세션 만료까지 보존하고 이후 정리한다", async () => {
    const store = createMemoryReplayStore({ maxEntries: 1 });
    assert.equal(await store.claim("session-a:1", START_TIME + 300_000, START_TIME), true);
    assert.equal(await store.claim("session-a:1", START_TIME + 300_000, START_TIME + 299_999), false);
    assert.equal(await store.claim("session-b:1", START_TIME + 600_000, START_TIME + 300_000), true);
});

test("과도한 크기·잘못된 Base64·태그 길이·비정상 순번을 거절한다", async () => {
    const { client, server } = channelFixture();
    assert.throws(() => client.seal("x".repeat(MAX_PAYLOAD_BYTES), REQUEST), /PAYLOAD_TOO_LARGE/);
    const packet = client.seal({}, REQUEST);
    const edits = [
        { data: packet.data + "\n" }, { data: "!" }, { data: "A".repeat(100_000) },
        { tag: Buffer.alloc(15).toString("base64") },
        { seq: -1 }, { seq: 0 }, { seq: 1.5 }, { seq: Number.MAX_SAFE_INTEGER + 1 }
    ];
    for (const edit of edits) {
        await assert.rejects(server.open({ ...packet, ...edit }, REQUEST, USER_REF), /INVALID_PACKET/);
    }
});

test("닫힌 채널은 다시 암호화하거나 복호화하지 않는다", async () => {
    const { client, server } = channelFixture();
    const packet = client.seal({}, REQUEST);
    client.close();
    server.close();
    assert.throws(() => client.seal({}, REQUEST), /CHANNEL_CLOSED/);
    await assert.rejects(server.open(packet, REQUEST, USER_REF), /CHANNEL_CLOSED/);
});
