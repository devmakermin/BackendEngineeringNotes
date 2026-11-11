"use strict";

const crypto = require("node:crypto");

const VERSION = 1;
const SUITE = "P256-ED25519-HKDF-SHA256-A256GCM-DEMO";
const SESSION_LIFETIME_MS = 300_000;
const CLOCK_TOLERANCE_MS = 30_000;

function requireCondition(condition) {
    if (!condition) {
        throw new Error("INVALID_HANDSHAKE");
    }
}

function decodeBase64(value, length) {
    requireCondition(typeof value === "string" && value.length === 4 * Math.ceil(length / 3));
    const decoded = Buffer.from(value, "base64");
    requireCondition(decoded.length === length && decoded.toString("base64") === value);
    return decoded;
}

function validateHello(hello) {
    requireCondition(hello && typeof hello === "object");
    decodeBase64(hello.clientPublicKey, 65);
    decodeBase64(hello.clientNonce, 32);
}

function encodeTranscript(reply) {
    // 필드 순서와 타입을 고정한다. 공개키 외의 문맥도 서명 대상이다.
    return Buffer.from(JSON.stringify([
        reply.v, reply.suite, reply.sid, reply.userRef, reply.issuedAt, reply.expiresAt,
        reply.clientPublicKey, reply.clientNonce, reply.serverPublicKey, reply.serverNonce
    ]), "utf8");
}

function makeSession(ecdh, peerPublicKey, reply) {
    return {
        sid: reply.sid,
        userRef: reply.userRef,
        issuedAt: reply.issuedAt,
        expiresAt: reply.expiresAt,
        secret: ecdh.computeSecret(decodeBase64(peerPublicKey, 65)),
        salt: crypto.createHash("sha256").update(encodeTranscript(reply)).digest()
    };
}

function createClientHandshake() {
    let ecdh = crypto.createECDH("prime256v1");
    const hello = Object.freeze({
        clientPublicKey: ecdh.generateKeys().toString("base64"),
        clientNonce: crypto.randomBytes(32).toString("base64")
    });

    function complete(reply, trustedServerPublicKey, expectedUserRef, now = Date.now()) {
        requireCondition(ecdh !== null && reply && Number.isSafeInteger(now));
        requireCondition(reply.v === VERSION && reply.suite === SUITE);
        requireCondition(typeof reply.sid === "string" && /^[a-f0-9]{32}$/.test(reply.sid));
        requireCondition(typeof expectedUserRef === "string" && reply.userRef === expectedUserRef);
        requireCondition(/^[A-Za-z0-9_-]{1,64}$/.test(reply.userRef));
        requireCondition(reply.clientPublicKey === hello.clientPublicKey);
        requireCondition(reply.clientNonce === hello.clientNonce);
        requireCondition(Number.isSafeInteger(reply.issuedAt) && Number.isSafeInteger(reply.expiresAt));
        requireCondition(reply.expiresAt - reply.issuedAt === SESSION_LIFETIME_MS);
        requireCondition(Math.abs(now - reply.issuedAt) <= CLOCK_TOLERANCE_MS && now < reply.expiresAt);
        decodeBase64(reply.serverPublicKey, 65);
        decodeBase64(reply.serverNonce, 32);
        requireCondition(trustedServerPublicKey?.type === "public");
        requireCondition(trustedServerPublicKey.asymmetricKeyType === "ed25519");
        requireCondition(crypto.verify(
            null, encodeTranscript(reply), trustedServerPublicKey, decodeBase64(reply.signature, 64)
        ));
        const session = makeSession(ecdh, reply.serverPublicKey, reply);
        // 완료한 핸드셰이크는 다시 사용하지 않는다. JS에서 확실한 메모리 소거는 보장하지 않는다.
        ecdh = null;
        return session;
    }

    return { hello, complete };
}

function acceptClientHandshake(hello, signingPrivateKey, authenticatedUserRef, now = Date.now()) {
    validateHello(hello);
    requireCondition(signingPrivateKey?.type === "private");
    requireCondition(signingPrivateKey.asymmetricKeyType === "ed25519");
    requireCondition(typeof authenticatedUserRef === "string");
    requireCondition(/^[A-Za-z0-9_-]{1,64}$/.test(authenticatedUserRef));
    requireCondition(Number.isSafeInteger(now) && now >= 0);
    requireCondition(Number.isSafeInteger(now + SESSION_LIFETIME_MS));
    const ecdh = crypto.createECDH("prime256v1");
    const reply = {
        v: VERSION,
        suite: SUITE,
        sid: crypto.randomBytes(16).toString("hex"),
        // 반드시 기존 인증 미들웨어에서 확인한 사용자 참조값을 전달한다.
        userRef: authenticatedUserRef,
        issuedAt: now,
        expiresAt: now + SESSION_LIFETIME_MS,
        clientPublicKey: hello.clientPublicKey,
        clientNonce: hello.clientNonce,
        serverPublicKey: ecdh.generateKeys().toString("base64"),
        serverNonce: crypto.randomBytes(32).toString("base64")
    };
    const session = makeSession(ecdh, hello.clientPublicKey, reply);
    reply.signature = crypto.sign(null, encodeTranscript(reply), signingPrivateKey).toString("base64");
    return { reply: Object.freeze(reply), session };
}

module.exports = {
    createClientHandshake,
    acceptClientHandshake,
    SESSION_LIFETIME_MS,
    CLOCK_TOLERANCE_MS
};
