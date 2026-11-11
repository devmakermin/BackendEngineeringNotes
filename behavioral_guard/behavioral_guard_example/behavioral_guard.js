"use strict";

// 실행 및 운영 한계는 README.md 참고. 실제 인증 미들웨어만 req.user.id를 설정한다.
const crypto = require("node:crypto");
const express = require("express");
const { createClientPool, WatchError } = require("redis");
const { setTimeout: delay } = require("node:timers/promises");

const WINDOWS = Object.freeze([
    { name: "5m", seconds: 300, counterLimit: 8, scoreLimit: 12 },
    { name: "1h", seconds: 3600, counterLimit: 24, scoreLimit: 36 },
    { name: "24h", seconds: 86400, counterLimit: 60, scoreLimit: 90 }
].map(Object.freeze));
const RISK = Object.freeze({
    UNKNOWN_API_ROUTE: 1,
    AUTHENTICATION_FAILURE: 2,
    AUTHORIZATION_DENIED: 3,
    INVALID_WORKFLOW_TRANSITION: 8
});

const TRANSACTION_RETRIES = 32;

function createRedisPool(url) {
    return createClientPool({
        url,
        disableOfflineQueue: true,
        commandsQueueMaxLength: 256,
        socket: { connectTimeout: 1000 }
    }, { minimum: 1, maximum: 10, acquireTimeout: 300 });
}

function createGuard(redis, options = {}) {
    const {
        hmacSecret = process.env.DEFENSE_HMAC_SECRET,
        mode = process.env.DETECTION_MODE || "score",
        prefix = "abuse:example:v1",
        now,
        logger = console
    } = options;

    if (typeof hmacSecret !== "string" || hmacSecret.length < 32) {
        throw new Error("DEFENSE_HMAC_SECRET must contain 32+ characters");
    }
    if (!["score", "counter"].includes(mode)) {
        throw new Error("DETECTION_MODE must be score or counter");
    }
    if (typeof prefix !== "string" || !/^[a-zA-Z0-9:_-]+$/.test(prefix)) {
        throw new Error("prefix must contain only letters, digits, colon, underscore or hyphen");
    }

    function identityFor(kind, value) {
        const token = crypto.createHmac("sha256", hmacSecret)
            .update(`${kind}:${String(value)}`).digest("hex");
        return { kind, subject: `{${kind}:${token}}` };
    }

    function identitiesFor(req) {
        const result = [];
        const remoteIp = req.ip || req.socket?.remoteAddress;
        if (remoteIp) {
            result.push(identityFor("ip", remoteIp));
        }
        // 클라이언트 입력이 아닌 검증된 인증 미들웨어의 결과만 사용한다.
        if (req.user && req.user.id !== undefined && req.user.id !== null) {
            result.push(identityFor("account", req.user.id));
        }
        return result;
    }

    function actionKey(identity) {
        return `${prefix}:deny:auto:${identity.subject}`;
    }

    function manualDenyKey(identity) {
        return `${prefix}:deny:manual:${identity.subject}`;
    }

    async function abuseGate(req, res, next) {
        try {
            const checks = identitiesFor(req).flatMap((identity) => [
                manualDenyKey(identity), actionKey(identity)
            ]);
            // 다른 주체는 다른 슬롯에 있을 수 있으므로 MGET 대신 개별 GET을 사용한다.
            const state = await Promise.all(checks.map((key) => redis.get(key)));
            if (state.some((value) => value !== null)) {
                return res.status(429).json({ error: "Too Many Requests" });
            }
        } catch {
            // 포착한 오류는 fail-open. 명령 지연 상한과 회로 차단은 별도 운영 과제다.
            logger.error("[abuse-gate] Redis operation failed; allowing request");
        }
        next();
    }

    async function observeRisk(req, riskType) {
        if (!Object.hasOwn(RISK, riskType)) {
            throw new Error("Unknown risk event");
        }
        const amount = mode === "score" ? RISK[riskType] : 1;
        // 기본 시간 기준은 Redis 마스터다. now는 테스트에서만 주입한다.
        const serverTime = now ? null : await redis.time();
        const atMs = now ? now() : Number(serverTime[0]) * 1000 + Math.floor(Number(serverTime[1]) / 1000);
        const thresholds = WINDOWS.map((window) => (
            mode === "score" ? window.scoreLimit : window.counterLimit
        ));

        for (const identity of identitiesFor(req)) {
            const bucketKeys = WINDOWS.map((window) => {
                const bucket = Math.floor(atMs / (window.seconds * 1000));
                return `${prefix}:risk:${identity.subject}:${mode}:${window.name}:${bucket}`;
            });
            // WATCH 상태는 연결에 속하므로 이 콜백 동안 연결을 독점한다.
            await redis.execute(async (client) => {
                let connectionChanged = false;
                const markChanged = () => { connectionChanged = true; };
                const assertConnected = () => {
                    if (connectionChanged || !client.isReady) {
                        throw new Error("Redis connection changed during observation");
                    }
                };
                client.on("error", markChanged);
                client.on("reconnecting", markChanged);
                try {
                    // 이전 작업에서 정리가 실패했더라도 새 작업에 WATCH가 남지 않게 한다.
                    await client.unwatch();
                    for (let attempt = 0; attempt < TRANSACTION_RETRIES; attempt += 1) {
                        assertConnected();
                        await client.watch(bucketKeys);
                        const values = await Promise.all(bucketKeys.map((key) => client.get(key)));
                        assertConnected();
                        const totals = values.map((value) => {
                            const count = value === null ? 0 : Number(value);
                            if ((value !== null && !/^\d+$/.test(value)) || count < 0 ||
                                !Number.isSafeInteger(count + amount)) {
                                throw new Error("Invalid risk counter");
                            }
                            return count + amount;
                        });
                        // 임계치 판단은 Node.js에서 하고 저장만 MULTI/EXEC로 묶는다.
                        const transaction = client.multi();
                        bucketKeys.forEach((key, index) => {
                            transaction.incrBy(key, amount);
                            transaction.expire(key, WINDOWS[index].seconds * 2, "NX");
                        });
                        if (totals.some((total, index) => total >= thresholds[index])) {
                            transaction.set(actionKey(identity), riskType, {
                                EX: identity.kind === "ip" ? 1800 : 900,
                                NX: true
                            });
                        }
                        assertConnected();
                        try {
                            await transaction.exec();
                            return;
                        } catch (error) {
                            if (!(error instanceof WatchError)) {
                                throw error;
                            }
                            // 다른 서버가 먼저 저장한 경우에만 최신 값을 다시 읽는다.
                            await delay(Math.min(attempt + 1, 5));
                        }
                    }
                    throw new Error("Risk transaction contention limit exceeded");
                } finally {
                    client.off("error", markChanged);
                    client.off("reconnecting", markChanged);
                    if (client.isReady) {
                        await client.unwatch();
                    }
                }
            });
        }

        if (riskType === "UNKNOWN_API_ROUTE") {
            const bucket = Math.floor(atMs / 300000);
            const key = `${prefix}:observe:unknown-route:5m:${bucket}`;
            // 증분과 최초 만료 설정을 함께 저장한다. Redis 7+ EXPIRE NX를 사용한다.
            const [count] = await redis.multi().incr(key).expire(key, 600, "NX").exec();
            if (Number(count) === 100) {
                // 단순 임계치 알림 예제. 전역 집계를 근거로 전체 사용자를 차단하지 않는다.
                logger.warn("[abuse-watch] 100 unknown API routes in one fixed 5m bucket");
            }
        }
    }

    async function safeObserve(req, riskType) {
        try {
            await observeRisk(req, riskType);
            return true;
        } catch {
            // 오류 객체에는 URL/인증 정보 등이 포함될 수 있어 그대로 출력하지 않는다.
            logger.error("[abuse-observer] Risk observation failed");
            return false;
        }
    }

    return { abuseGate, observeRisk, safeObserve };
}

function createApp(redis, options = {}) {
    const app = express();
    const { authenticate, trustedProxyCidrs = [] } = options;
    const { abuseGate, safeObserve } = createGuard(redis, options);

    if (trustedProxyCidrs.length > 0) {
        app.set("trust proxy", trustedProxyCidrs);
    }
    app.get("/health", (req, res) => res.json({ ok: true }));
    // 실제 JWT/세션 검증만 연결한다. X-User-Id 등으로 req.user를 만들지 않는다.
    if (authenticate) {
        app.use("/api", authenticate);
    }
    app.use("/api", abuseGate);
    app.use(express.json({ limit: "32kb" }));
    app.get("/api/ping", (req, res) => res.json({ pong: true }));

    // 실제 업무 코드에서 인증 실패/권한 거절/상태 전이 위반을 선별하여 기록한다.
    // 인가 및 상태 검증은 점수와 무관하게 항상 강제한다.
    app.use("/api", async (req, res) => {
        await safeObserve(req, "UNKNOWN_API_ROUTE");
        res.status(404).json({ error: "Not Found" });
    });
    app.use((error, req, res, next) => {
        if (res.headersSent) {
            return next(error);
        }
        const suppliedStatus = error.status ?? error.statusCode;
        const status = Number.isInteger(suppliedStatus) && suppliedStatus >= 400 && suppliedStatus < 500
            ? suppliedStatus : 500;
        res.status(status).json({ error: status === 500 ? "Internal Server Error" : "Invalid Request" });
    });
    return app;
}

async function main() {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("PORT must be an integer from 1 to 65535");
    }
    const redis = createRedisPool(process.env.REDIS_URL || "redis://127.0.0.1:6379");
    redis.on("error", () => console.error("[redis] Connection or command error"));
    const trustedProxyCidrs = (process.env.TRUST_PROXY_CIDRS || "")
        .split(",").map((item) => item.trim()).filter(Boolean);
    const app = createApp(redis, { trustedProxyCidrs });
    try {
        await redis.connect();
        const server = app.listen(port, "127.0.0.1", () => {
            console.log(`Example API listening at http://127.0.0.1:${port}`);
        });
        server.on("error", () => {
            console.error("[server] Could not listen");
            redis.destroy();
            process.exitCode = 1;
        });
    } catch (error) {
        if (redis.isOpen) {
            redis.destroy();
        }
        throw error;
    }
}

if (require.main === module) {
    void main().catch(() => {
        console.error("Startup failed; check required settings and Redis availability");
        process.exitCode = 1;
    });
}

module.exports = { createGuard, createApp, createRedisPool, RISK, WINDOWS };
