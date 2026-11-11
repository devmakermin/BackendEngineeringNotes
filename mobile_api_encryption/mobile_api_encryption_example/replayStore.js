"use strict";

function createMemoryReplayStore({ maxEntries = 10_000 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
        throw new Error("INVALID_REPLAY_CAPACITY");
    }
    const entries = new Map();

    // 단일 프로세스에서만 원자적이다. 분산 환경의 Redis를 구현한 것이 아니다.
    async function claim(key, expiresAt, now) {
        if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
            throw new Error("SESSION_EXPIRED");
        }
        for (const [entryKey, expiry] of entries) {
            if (expiry <= now) {
                entries.delete(entryKey);
            }
        }
        if (entries.has(key)) {
            return false;
        }
        if (entries.size >= maxEntries) {
            throw new Error("REPLAY_STORE_FULL");
        }
        // 조회와 저장 사이에 await가 없으므로 동일 이벤트 루프에서 중복 예약하지 않는다.
        entries.set(key, expiresAt);
        return true;
    }

    return { claim };
}

module.exports = { createMemoryReplayStore };
