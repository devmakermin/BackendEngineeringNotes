"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { createClient } = require("redis");
const { createGuard, createApp, createRedisPool } = require("../behavioral_guard");

// 전용 로컬 Redis에서만 실행한다. 운영 키를 초기화하는 명령은 사용하지 않는다.
const redisUrl = process.env.REDIS_TEST_URL || "redis://127.0.0.1:16379";
const hmacSecret = crypto.randomBytes(32).toString("hex");
const pool = createRedisPool(redisUrl);
const admin = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
pool.on("error", () => {});
admin.on("error", () => {});
before(async () => { await Promise.all([pool.connect(), admin.connect()]); });
after(async () => {
    if (pool.isOpen) await pool.close();
    if (admin.isOpen) await admin.close();
});

function setup(t, extra = {}, targetPool = pool) {
    const prefix = `test:behavioral:${crypto.randomUUID()}`;
    const warnings = [];
    const options = {
        hmacSecret, mode: "score", prefix,
        now: () => 86400000,
        logger: { error() {}, warn(message) { warnings.push(message); } },
        ...extra
    };
    t.after(async () => {
        const keys = await admin.keys(`${prefix}:*`);
        if (keys.length) await admin.del(keys);
    });
    return { guard: createGuard(targetPool, options), prefix, warnings, options };
}

async function status(guard, req) {
    let code = 200;
    const response = { status(value) { code = value; return this; }, json() {} };
    await guard.abuseGate(req, response, () => {});
    return code;
}

async function repeat(guard, req, count, event = "UNKNOWN_API_ROUTE") {
    for (let i = 0; i < count; i += 1) await guard.observeRisk(req, event);
}

test("score threshold creates a 30-minute IP ban and expiring observation keys", async (t) => {
    const { guard, prefix } = setup(t);
    const req = { ip: "192.0.2.1" };
    await repeat(guard, req, 11);
    assert.equal(await status(guard, req), 200);
    await repeat(guard, req, 1);
    assert.equal(await status(guard, req), 429);
    const keys = await admin.keys(`${prefix}:*`);
    assert.equal(keys.length, 5);
    for (const key of keys) assert.ok(await admin.ttl(key) > 0);
    const [ban] = keys.filter((key) => key.includes(":deny:auto:"));
    assert.ok(await admin.ttl(ban) <= 1800);
    assert.ok(await admin.ttl(ban) >= 1798);
});

test("counter uses event counts while score uses weights", async (t) => {
    const counter = setup(t, { mode: "counter" }).guard;
    const score = setup(t).guard;
    const req = { ip: "192.0.2.2" };
    await repeat(counter, req, 2, "INVALID_WORKFLOW_TRANSITION");
    await repeat(score, req, 2, "INVALID_WORKFLOW_TRANSITION");
    assert.equal(await status(counter, req), 200);
    assert.equal(await status(score, req), 429);
    await repeat(counter, req, 6, "AUTHENTICATION_FAILURE");
    assert.equal(await status(counter, req), 429);
});

test("verified account accumulates across rotating IPs and is banned for 15 minutes", async (t) => {
    const { guard, prefix } = setup(t);
    for (let i = 0; i < 12; i += 1) {
        await guard.observeRisk({ ip: `192.0.2.${i + 1}`, user: { id: "demo-account" } }, "UNKNOWN_API_ROUTE");
    }
    assert.equal(await status(guard, { ip: "198.51.100.1", user: { id: "demo-account" } }), 429);
    assert.equal(await status(guard, { ip: "198.51.100.1", user: { id: "other" } }), 200);
    const [key] = await admin.keys(`${prefix}:deny:auto:*`);
    assert.ok(key.includes("{account:"));
    assert.ok(!key.includes("demo-account"));
    assert.ok(await admin.ttl(key) <= 900);
});

test("1-hour window detects events below each 5-minute threshold", async (t) => {
    let time = 86400000;
    const { guard, prefix } = setup(t, { now: () => time });
    const req = { ip: "192.0.2.3" };
    for (let group = 0; group < 6; group += 1) {
        await repeat(guard, req, 6);
        time += 600000;
    }
    assert.equal(await status(guard, req), 429);
    const keys = await admin.keys(`${prefix}:risk:*:5m:*`);
    assert.equal(keys.length, 6);
    for (const key of keys) assert.equal(await admin.get(key), "6");
});

test("24-hour window detects low-and-slow events, using an injected bucket clock", async (t) => {
    let time = 86400000;
    const { guard } = setup(t, { now: () => time });
    const req = { ip: "192.0.2.4" };
    for (let i = 0; i < 89; i += 1) {
        await guard.observeRisk(req, "UNKNOWN_API_ROUTE");
        time += 600000;
    }
    assert.equal(await status(guard, req), 200);
    await guard.observeRisk(req, "UNKNOWN_API_ROUTE");
    assert.equal(await status(guard, req), 429);
});

test("fixed windows reset at a boundary, with longer windows retaining history", async (t) => {
    let time = 86400000 + 299999;
    const { guard, prefix } = setup(t);
    const boundaryGuard = createGuard(pool, {
        hmacSecret, mode: "score", prefix, now: () => time
    });
    const req = { ip: "192.0.2.5" };
    await repeat(boundaryGuard, req, 11);
    time += 1;
    await repeat(boundaryGuard, req, 11);
    assert.equal(await status(guard, req), 200);
    const [hourKey] = await admin.keys(`${prefix}:risk:*:1h:*`);
    assert.equal(await admin.get(hourKey), "22");
});

test("two independent pools preserve counts under concurrent WATCH transactions", async (t) => {
    const secondPool = createRedisPool(redisUrl);
    secondPool.on("error", () => {});
    await secondPool.connect();
    t.after(() => secondPool.close());
    const { guard, prefix, options } = setup(t);
    const otherGuard = createGuard(secondPool, options);
    const req = { ip: "192.0.2.6" };
    await Promise.all(Array.from({ length: 24 }, (_, i) => (
        (i % 2 ? guard : otherGuard).observeRisk(req, "AUTHENTICATION_FAILURE")
    )));
    const keys = await admin.keys(`${prefix}:risk:*`);
    for (const key of keys) assert.equal(await admin.get(key), "48");
    assert.equal(await status(otherGuard, req), 429);
});

test("automatic TTL is not extended; expiry permits normal requests, then a new event can re-ban", async (t) => {
    const { guard, prefix } = setup(t);
    const req = { ip: "192.0.2.7" };
    await repeat(guard, req, 12);
    const [ban] = await admin.keys(`${prefix}:deny:auto:*`);
    await admin.pExpire(ban, 200);
    await guard.observeRisk(req, "UNKNOWN_API_ROUTE");
    assert.ok(await admin.pTTL(ban) <= 200);
    await delay(250);
    assert.equal(await status(guard, req), 200);
    await guard.observeRisk(req, "UNKNOWN_API_ROUTE");
    assert.equal(await status(guard, req), 429);
});

test("manual bans have no automatic TTL and remain independent of risk counts", async (t) => {
    const { guard, prefix } = setup(t);
    const req = { ip: "192.0.2.8" };
    await guard.observeRisk(req, "AUTHENTICATION_FAILURE");
    const [riskKey] = await admin.keys(`${prefix}:risk:*:5m:*`);
    const subject = riskKey.match(/\{[^}]+\}/)[0];
    const manualKey = `${prefix}:deny:manual:${subject}`;
    await admin.set(manualKey, "operator-reviewed");
    assert.equal(await admin.ttl(manualKey), -1);
    assert.equal(await status(guard, req), 429);
    await admin.del(manualKey);
    assert.equal(await status(guard, req), 200);
});

test("anonymous aggregate alerts once and never creates a global ban", async (t) => {
    const { guard, prefix, warnings } = setup(t);
    for (let i = 0; i < 101; i += 1) {
        await guard.observeRisk({ ip: `198.51.100.${i + 1}` }, "UNKNOWN_API_ROUTE");
    }
    assert.equal(warnings.length, 1);
    assert.deepEqual(await admin.keys(`${prefix}:deny:auto:*`), []);
    const [key] = await admin.keys(`${prefix}:observe:*`);
    assert.equal(await admin.get(key), "101");
    assert.ok(await admin.ttl(key) > 0);
});

test("bad stored counter aborts without writes, then the pooled connection is reusable", async (t) => {
    const { guard, prefix } = setup(t);
    const req = { ip: "192.0.2.9" };
    await guard.observeRisk(req, "AUTHENTICATION_FAILURE");
    const [key] = await admin.keys(`${prefix}:risk:*:5m:*`);
    await admin.set(key, "invalid");
    await assert.rejects(guard.observeRisk(req, "AUTHENTICATION_FAILURE"), /Invalid risk counter/);
    const [hour] = await admin.keys(`${prefix}:risk:*:1h:*`);
    assert.equal(await admin.get(hour), "2");
    await admin.set(key, "2");
    await guard.observeRisk(req, "AUTHENTICATION_FAILURE");
    assert.equal(await admin.get(key), "4");
});

test("actual HTTP routes record only unmatched API requests and enforce the next request", async (t) => {
    const { options, prefix } = setup(t, { now: undefined });
    const server = createApp(pool, options).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/api/ping`)).status, 200);
    assert.equal((await fetch(`${url}/favicon.ico`)).status, 404);
    assert.deepEqual(await admin.keys(`${prefix}:*`), []);
    for (let i = 0; i < 12; i += 1) {
        assert.equal((await fetch(`${url}/api/missing`)).status, 404);
    }
    assert.equal((await fetch(`${url}/api/ping`)).status, 429);
    assert.equal((await fetch(`${url}/health`)).status, 200);
});

test("guard runs with a Redis ACL user that cannot execute scripts", async (t) => {
    const user = `behavioral-test-${crypto.randomUUID()}`;
    await admin.sendCommand(["ACL", "SETUSER", user, "on", "nopass", "~test:behavioral:*", "+@all", "-@scripting"]);
    // 무비밀번호 테스트 사용자는 전용 로컬 Redis에서 생성하고 테스트가 끝나면 삭제한다.
    const restrictedUrl = new URL(redisUrl);
    restrictedUrl.username = user;
    restrictedUrl.password = "";
    const aclPool = createRedisPool(restrictedUrl.toString());
    aclPool.on("error", () => {});
    t.after(async () => {
        if (aclPool.isOpen) await aclPool.close();
        await admin.sendCommand(["ACL", "DELUSER", user]);
    });
    await aclPool.connect();
    const { guard } = setup(t, {}, aclPool);
    await repeat(guard, { ip: "192.0.2.10" }, 12);
    assert.equal(await status(guard, { ip: "192.0.2.10" }), 429);
    const permissions = await admin.sendCommand(["ACL", "GETUSER", user]);
    const commands = permissions instanceof Map ? permissions.get("commands") : permissions.commands;
    assert.match(commands, /-@scripting/);
});
