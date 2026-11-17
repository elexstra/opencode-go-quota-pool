/**
 * opencode-go-quota-pool 的本地回归：不连网、不起宿主，只验证轮转判据与用量解析。
 * 跑法：node verify.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, _internal } from './lib/index.js';

function makeHome() {
    const home = mkdtempSync(join(tmpdir(), 'opencode-go-quota-pool-verify-'));
    process.env.DSH_HOME = home;
    return home;
}

function credentialsStore(initial) {
    const store = { ...initial };
    return {
        store,
        resolve: async (ref) => (store[ref] ? { value: store[ref], source: 'mock' } : undefined),
        set: async (ref, value) => { store[ref] = value; }
    };
}

function makeCtx(credentials) {
    const hooks = {};
    return {
        hooks,
        logger: { info: () => {}, warn: () => {} },
        on: (name, fn) => { hooks[name] = fn; },
        inject: (services, callback) => {
            if (services.includes('credentials')) callback({ get: () => credentials });
            if (services.includes('webServer')) callback({ get: () => undefined });
        }
    };
}

const text = (value) => ({ type: 'text', text: value });
const finishError = (message, code) => ({ type: 'finish', reason: { kind: 'error', failure: { message, code: code ?? 'PI_AI_ERROR' } } });

async function collect(iterator) {
    const chunks = [];
    for await (const chunk of iterator) chunks.push(chunk);
    return chunks;
}

async function runStream(ctx, provider, next) {
    const handler = ctx.hooks['llm/stream'];
    assert.equal(typeof handler, 'function', 'llm/stream 应该被挂钩');
    return collect(handler({ provider }, next));
}

function readState() {
    return JSON.parse(readFileSync(join(process.env.DSH_HOME, 'opencode-go-pool.json'), 'utf8'));
}

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test('首次启动把生效 key 迁进槽 a（幂等）', async () => {
    makeHome();
    const credentials = credentialsStore({ OPENCODE_GO_API_KEY: 'key-active' });
    const ctx = makeCtx(credentials);
    apply(ctx, {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(credentials.store.OPENCODE_GO_POOL_A, 'key-active');
    assert.equal(credentials.store.OPENCODE_GO_API_KEY, 'key-active');
    assert.equal(readState().active, 'a');
});

test('只有 reached limit 才轮转', async () => {
    makeHome();
    const credentials = credentialsStore({ OPENCODE_GO_API_KEY: 'key-a', OPENCODE_GO_POOL_A: 'key-a', OPENCODE_GO_POOL_B: 'key-b' });
    const ctx = makeCtx(credentials);
    apply(ctx, {});
    const chunks = await runStream(ctx, 'opencode-go', () => (async function* () {
        yield text('partial');
        yield finishError('You have reached your usage limit for this period.', 'QUOTA');
    })());
    assert.equal(chunks.at(-1).reason.kind, 'error');
    assert.equal(credentials.store.OPENCODE_GO_API_KEY, 'key-b', 'reached limit 应切到槽 b');
    const state = readState();
    assert.equal(state.active, 'b');
    assert.ok(state.slots.a.cooldownUntil, '失败槽应进冷却');
});

test('限流 / 认证 / 网络错误都不轮转', async () => {
    for (const message of ['Rate limit exceeded (429)', 'Unauthorized: invalid api key', 'fetch failed']) {
        makeHome();
        const credentials = credentialsStore({ OPENCODE_GO_API_KEY: 'key-a', OPENCODE_GO_POOL_A: 'key-a', OPENCODE_GO_POOL_B: 'key-b' });
        const ctx = makeCtx(credentials);
        apply(ctx, {});
        await runStream(ctx, 'opencode-go', () => (async function* () {
            yield finishError(message);
        })());
        assert.equal(credentials.store.OPENCODE_GO_API_KEY, 'key-a', `「${message}」不应触发轮转`);
    }
});

test('冷却期内不切回', async () => {
    makeHome();
    const credentials = credentialsStore({ OPENCODE_GO_API_KEY: 'key-a', OPENCODE_GO_POOL_A: 'key-a', OPENCODE_GO_POOL_B: 'key-b' });
    const ctx = makeCtx(credentials);
    apply(ctx, {});
    await runStream(ctx, 'opencode-go', () => (async function* () {
        yield finishError('reached limit');
    })());
    assert.equal(credentials.store.OPENCODE_GO_API_KEY, 'key-b');
    await runStream(ctx, 'opencode-go', () => (async function* () {
        yield finishError('reached limit');
    })());
    assert.equal(credentials.store.OPENCODE_GO_API_KEY, 'key-b', '冷却期内不应切回 a');
    assert.equal(readState().active, 'b');
});

test('非 opencode-go 的失败直通，不切 key', async () => {
    makeHome();
    const credentials = credentialsStore({ OPENCODE_GO_API_KEY: 'key-a', OPENCODE_GO_POOL_A: 'key-a', OPENCODE_GO_POOL_B: 'key-b' });
    const ctx = makeCtx(credentials);
    apply(ctx, {});
    const chunks = await collect(ctx.hooks['llm/stream']({ provider: 'deepseek' }, () => (async function* () {
        yield finishError('reached limit');
    })()));
    assert.equal(chunks.length, 1);
    assert.equal(credentials.store.OPENCODE_GO_API_KEY, 'key-a');
});

test('next() 只调用一次（0.2.2 的守卫）', async () => {
    makeHome();
    const credentials = credentialsStore({ OPENCODE_GO_API_KEY: 'key-a', OPENCODE_GO_POOL_A: 'key-a', OPENCODE_GO_POOL_B: 'key-b' });
    const ctx = makeCtx(credentials);
    apply(ctx, {});
    let calls = 0;
    await runStream(ctx, 'opencode-go', () => {
        calls += 1;
        return (async function* () { yield finishError('reached limit'); })();
    });
    assert.equal(calls, 1, '不应二次调用 next()');
});

test('用量解析：meters 归一成剩余百分比与重置倒计时', () => {
    const windows = _internal.parseMeters({
        access: {
            endsAt: '2026-11-17T12:00:00.000Z',
            meters: {
                fiveHour: { usedMicroCents: '3000000', limitMicroCents: '12000000', resetsAt: '2026-11-17T07:00:00.000Z' },
                week: { usedMicroCents: '5000000', limitMicroCents: '30000000', resetsAt: '2026-11-20T00:00:00.000Z' },
                month: { usedMicroCents: '10000000', limitMicroCents: '60000000', resetsAt: '2026-12-01T00:00:00.000Z' }
            }
        }
    }).windows;
    assert.deepEqual(windows.map((window) => window.key), ['rolling', 'weekly', 'monthly']);
    assert.equal(windows[0].remainingPercent, 75);
    assert.ok(windows[0].resetInSeconds > 0);
});

test('用量解析：没有 meters 时给出原因', () => {
    const parsed = _internal.parseMeters({ access: {} });
    assert.equal(parsed.windows.length, 0);
    assert.equal(parsed.reason, 'no-meters');
});

test('用量解析（zen）：毫秒时间戳与 ISO 串都算重置倒计时', () => {
    const ms = Date.now() + 3600 * 1000;
    const windows = _internal.parseZenUsage({
        usage: {
            rolling: { percent: 25, resetsAt: ms },
            weekly: { percent: 60, resetsAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString() },
            monthly: { percent: 80, resetsAt: ms }
        }
    }).windows;
    assert.deepEqual(windows.map((window) => window.key), ['rolling', 'weekly', 'monthly']);
    assert.equal(windows[0].remainingPercent, 75);
    assert.equal(windows[1].remainingPercent, 40);
    assert.ok(windows[0].resetInSeconds > 0 && windows[1].resetInSeconds > 0);
});

test('用量解析（zen）：没有 usage 时给出原因', () => {
    const parsed = _internal.parseZenUsage({});
    assert.equal(parsed.windows.length, 0);
    assert.equal(parsed.reason, 'no-usage');
});

let failed = 0;
for (const { name, fn } of cases) {
    try {
        await fn();
        console.log(`ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`FAIL ${name}: ${error.message}`);
    }
}

if (failed > 0) {
    console.error(`${failed} 个用例失败`);
    process.exit(1);
}
console.log(`${cases.length} 个用例通过`);
