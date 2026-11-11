"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once, EventEmitter } = require("node:events");
const { WatchError } = require("redis");
const { createGuard, createApp } = require("../behavioral_guard");

const hmacSecret = crypto.randomBytes(32).toString("hex");
const logger = { error() {}, warn() {} };
const options = { hmacSecret, mode: "score", logger };

test("invalid secret, mode and key prefix fail before serving requests", () => {
    for (const secret of ["", "short", null]) {
        assert.throws(() => createGuard({}, { ...options, hmacSecret: secret }), /32/);
    }
    assert.throws(() => createGuard({}, { ...options, mode: "typo" }), /DETECTION_MODE/);
    assert.throws(() => createGuard({}, { ...options, prefix: "bad{tag}" }), /prefix/);
});

test("unverified headers do not create an account identity or replace the IP", async () => {
    const keys = [];
    const guard = createGuard({ async get(key) { keys.push(key); return null; } }, options);
    let passed = false;
    await guard.abuseGate({
        ip: "192.0.2.1",
        headers: { "x-user-id": "victim", "x-forwarded-for": "198.51.100.1" }
    }, {}, () => { passed = true; });
    assert.equal(passed, true);
    assert.equal(keys.length, 2);
    assert.ok(keys.every((key) => key.includes("{ip:") && !key.includes("192.0.2.1")));
});

test("verified account id zero is included independently of IP", async () => {
    const keys = [];
    const guard = createGuard({ async get(key) { keys.push(key); return null; } }, options);
    await guard.abuseGate({ ip: "192.0.2.1", user: { id: 0 } }, {}, () => {});
    assert.equal(keys.length, 4);
    assert.equal(keys.filter((key) => key.includes("{account:")).length, 2);
});

test("caught Redis failure allows the request without logging error contents", async () => {
    const logs = [];
    const guard = createGuard({ async get() { throw new Error("private-error-marker"); } }, {
        ...options, logger: { error(message) { logs.push(message); } }
    });
    let passed = false;
    await guard.abuseGate({ ip: "192.0.2.1" }, {}, () => { passed = true; });
    assert.equal(passed, true);
    assert.equal(logs.length, 1);
    assert.ok(!logs.join().includes("private-error-marker"));
});

test("unknown risk events fail explicitly and safeObserve contains the error", async () => {
    const guard = createGuard({}, options);
    await assert.rejects(guard.observeRisk({}, "toString"), /Unknown risk/);
    assert.equal(await guard.safeObserve({}, "typo"), false);
});

test("health and normal API work, and default proxy trust rejects spoofed headers", async (t) => {
    const keys = [];
    const app = createApp({ async get(key) { keys.push(key); return null; } }, options);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal(keys.length, 0);
    assert.equal((await fetch(`${url}/api/ping`)).status, 200);
    const originalKeys = [...keys];
    keys.length = 0;
    assert.equal((await fetch(`${url}/api/ping`, {
        headers: { "X-Forwarded-For": "203.0.113.99", "X-User-Id": "victim" }
    })).status, 200);
    assert.deepEqual(keys, originalKeys);
});

test("authentication errors keep HTTP status without exposing internal messages", async (t) => {
    const app = createApp({}, {
        ...options,
        authenticate(req, res, next) {
            next(Object.assign(new Error("private-auth-details"), { status: 401 }));
        }
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ping`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Invalid Request" });
});

function transactionDouble({ conflicts = 0, loseConnection = false } = {}) {
    const client = new EventEmitter();
    client.isReady = true;
    const state = { attempts: 0, unwatches: 0 };
    client.unwatch = async () => { state.unwatches += 1; };
    client.watch = async () => {};
    client.get = async () => {
        if (loseConnection) client.emit("reconnecting");
        return "0";
    };
    client.multi = () => ({
        incrBy() { return this; }, expire() { return this; }, set() { return this; },
        async exec() {
            state.attempts += 1;
            if (state.attempts <= conflicts) throw new WatchError();
            return [];
        }
    });
    return { client, state, pool: { async execute(fn) { return fn(client); } } };
}

test("WATCH conflicts are retried with a limit and always clean up connection state", async () => {
    const first = transactionDouble({ conflicts: 2 });
    const guard = createGuard(first.pool, { ...options, now: () => 86400000 });
    await guard.observeRisk({ ip: "192.0.2.1" }, "AUTHENTICATION_FAILURE");
    assert.equal(first.state.attempts, 3);
    assert.equal(first.state.unwatches, 2);
    const saturated = transactionDouble({ conflicts: Infinity });
    const limited = createGuard(saturated.pool, { ...options, now: () => 86400000 });
    await assert.rejects(limited.observeRisk({ ip: "192.0.2.1" }, "AUTHENTICATION_FAILURE"), /contention/);
    assert.equal(saturated.state.attempts, 32);
    assert.equal(saturated.client.listenerCount("reconnecting"), 0);
});

test("connection change during reads prevents a late transaction write", async () => {
    const { pool, state } = transactionDouble({ loseConnection: true });
    const guard = createGuard(pool, { ...options, now: () => 86400000 });
    await assert.rejects(guard.observeRisk({ ip: "192.0.2.1" }, "AUTHENTICATION_FAILURE"), /connection changed/);
    assert.equal(state.attempts, 0);
});
