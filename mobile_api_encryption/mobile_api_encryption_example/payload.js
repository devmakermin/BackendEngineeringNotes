"use strict";

const crypto = require("node:crypto");
const { CLOCK_TOLERANCE_MS } = require("./session");

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_SEQUENCE = 1_000_000;

function requireCondition(condition, code = "INVALID_PACKET") {
    if (!condition) {
        throw new Error(code);
    }
}

function validateContext(context, direction) {
    requireCondition(context && typeof context === "object", "INVALID_CONTEXT");
    requireCondition(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(context.method), "INVALID_CONTEXT");
    requireCondition(typeof context.target === "string" && context.target.length <= 2048, "INVALID_CONTEXT");
    requireCondition(/^\/[\x21-\x7E]*$/.test(context.target) && !context.target.includes("#"), "INVALID_CONTEXT");
    if (direction === "c2s") {
        requireCondition(context.status === 0 && context.requestSeq === 0, "INVALID_CONTEXT");
    } else {
        requireCondition(Number.isInteger(context.status) && context.status >= 100 && context.status <= 599);
        requireCondition(Number.isSafeInteger(context.requestSeq) && context.requestSeq > 0);
        requireCondition(context.requestSeq <= MAX_SEQUENCE);
    }
}

function decodeBase64(value, maxBytes, exactBytes) {
    requireCondition(typeof value === "string" && value.length <= 4 * Math.ceil(maxBytes / 3));
    const bytes = Buffer.from(value, "base64");
    requireCondition(bytes.length > 0 && bytes.length <= maxBytes && bytes.toString("base64") === value);
    requireCondition(exactBytes === undefined || bytes.length === exactBytes);
    return bytes;
}

function messageKey(session, direction, sequence) {
    const info = Buffer.from(JSON.stringify([
        "mobile-api-payload-demo-v1", session.sid, session.userRef, direction, sequence
    ]), "utf8");
    return Buffer.from(crypto.hkdfSync("sha256", session.secret, session.salt, info, 32));
}

function nonceFor(sequence) {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(BigInt(sequence), 4);
    return nonce;
}

function aadFor(session, packet, context) {
    return Buffer.from(JSON.stringify([
        packet.v, packet.sid, session.userRef, packet.direction, packet.seq, packet.ts,
        context.method, context.target, context.status, context.requestSeq
    ]), "utf8");
}

function createChannel(sourceSession, role, replayStore, clock = Date.now) {
    requireCondition(role === "client" || role === "server", "INVALID_ROLE");
    requireCondition(typeof replayStore?.claim === "function", "INVALID_REPLAY_STORE");
    requireCondition(Buffer.isBuffer(sourceSession.secret) && sourceSession.secret.length === 32);
    requireCondition(Buffer.isBuffer(sourceSession.salt) && sourceSession.salt.length === 32);
    const session = {
        ...sourceSession,
        secret: Buffer.from(sourceSession.secret),
        salt: Buffer.from(sourceSession.salt)
    };
    const outbound = role === "client" ? "c2s" : "s2c";
    const inbound = role === "client" ? "s2c" : "c2s";
    let nextSequence = 1;
    let closed = false;

    function requireActive(now) {
        requireCondition(!closed, "CHANNEL_CLOSED");
        requireCondition(Number.isSafeInteger(now), "INVALID_CLOCK");
        requireCondition(now >= session.issuedAt - CLOCK_TOLERANCE_MS, "INVALID_CLOCK");
        requireCondition(now < session.expiresAt, "SESSION_EXPIRED");
    }

    function seal(payload, context) {
        const now = clock();
        requireActive(now);
        validateContext(context, outbound);
        requireCondition(nextSequence <= MAX_SEQUENCE, "REKEY_REQUIRED");
        const json = JSON.stringify(payload);
        requireCondition(typeof json === "string", "INVALID_JSON_PAYLOAD");
        const plaintext = Buffer.from(json, "utf8");
        requireCondition(plaintext.length <= MAX_PAYLOAD_BYTES, "PAYLOAD_TOO_LARGE");
        // 채번 후 암호화 실패 시에도 번호를 되돌리지 않는다.
        const packet = {
            v: 1, sid: session.sid, direction: outbound, seq: nextSequence++, ts: now
        };
        const key = messageKey(session, outbound, packet.seq);
        try {
            const cipher = crypto.createCipheriv("aes-256-gcm", key, nonceFor(packet.seq), { authTagLength: 16 });
            cipher.setAAD(aadFor(session, packet, context));
            const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
            return Object.freeze({ ...packet, data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
        } finally {
            key.fill(0);
            plaintext.fill(0);
        }
    }

    async function open(input, context, authenticatedUserRef) {
        const now = clock();
        requireActive(now);
        requireCondition(authenticatedUserRef === session.userRef, "USER_MISMATCH");
        validateContext(context, inbound);
        requireCondition(input && typeof input === "object");
        const packet = { ...input };
        requireCondition(packet.v === 1 && packet.sid === session.sid && packet.direction === inbound);
        requireCondition(Number.isSafeInteger(packet.seq) && packet.seq > 0 && packet.seq <= MAX_SEQUENCE);
        requireCondition(Number.isSafeInteger(packet.ts));
        requireCondition(Math.abs(now - packet.ts) <= CLOCK_TOLERANCE_MS, "STALE_PACKET");
        const encrypted = decodeBase64(packet.data, MAX_PAYLOAD_BYTES);
        const tag = decodeBase64(packet.tag, 16, 16);
        const key = messageKey(session, inbound, packet.seq);
        let plaintext;
        let payload;
        try {
            const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonceFor(packet.seq), { authTagLength: 16 });
            decipher.setAAD(aadFor(session, packet, context));
            decipher.setAuthTag(tag);
            plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
            payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
        } catch {
            throw new Error("INVALID_PACKET");
        } finally {
            key.fill(0);
            plaintext?.fill(0);
        }
        // 인증 성공 뒤, 업무 처리 이전에 예약한다. 위조 요청이 seq를 선점하지 못하게 한다.
        const claimKey = `payload-demo:v1:${session.sid}:${inbound}:${packet.seq}`;
        const claimed = await replayStore.claim(claimKey, session.expiresAt, now);
        const afterClaim = clock();
        requireActive(afterClaim);
        requireCondition(Math.abs(afterClaim - packet.ts) <= CLOCK_TOLERANCE_MS, "STALE_PACKET");
        requireCondition(claimed === true, "REPLAY_DETECTED");
        return payload;
    }

    function close() {
        closed = true;
        session.secret.fill(0);
        session.salt.fill(0);
    }

    return { seal, open, close };
}

module.exports = { createChannel, MAX_PAYLOAD_BYTES, MAX_SEQUENCE };
