/**
 * opencode-go-quota-pool —— OpenCode Go 双订阅轮转池 + 用量条（宿主侧）
 *
 * 这个包由两个原先独立的 DSH 插件合并而来：
 * 1. dsh-quota-bars：从 OpenCode 控制台抓 rolling 5h / weekly / monthly 用量，
 *    经 `/api/quota/opencode-go` 给输入框下方的用量条。
 * 2. opencode-go-pool：两个 API Key 分槽存放，额度用尽时切到另一把。
 *
 * 合并后的联动：用量条显示的是「当前生效槽位（active slot）所属账号」的用量。
 * 每个槽有自己的控制台凭据文件（workspaceId + auth cookie），切槽后下一次轮询
 * 就换成新账号的条。pool 的状态接口也带上同一份用量快照。
 *
 * 轮转判据（只认一种）：上游 API 返回的消息里出现「reached limit」——额度真的
 * 打满才切；限流（429 RPM）、瞬时网络错误、认证失败都不切，避免把可恢复的抖动
 * 当成额度耗尽。
 *
 * 重试策略：本插件只切凭据、不重试。0.2.2 的 cordis 4.1.0 给 waterfall 的
 * next() 加了一次性守卫（第二次调用抛 "next() called multiple times"），而
 * pi-ai 失败前会先 yield usage，重试会撞 validateStream 的「usage more than
 * once」。重试交给 llm-retry：同一 step 内重新 prepareCall、重新 resolve 凭据，
 * 只要在 yield 失败 finish 之前把新 key 写进 activeRef，下一次尝试就用新 key。
 *
 * 凭据与安全：API key 只经 `ctx.inject(['credentials'])` 的 set/resolve 读写，
 * 落在 `.credentials.yaml`；控制台 cookie 只从配置目录读，不回显、不落日志。
 *
 * @module opencode-go-quota-pool
 */

import { existsSync, mkdirSync, promises as fsp, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdDecompress } from 'node:zlib';

/** Loader 诊断用的插件名。 */
export const name = 'opencode-go-quota-pool';

const DEFAULTS = {
    activeRef: 'OPENCODE_GO_API_KEY',
    // 只处理 provider 名以此开头的请求；别的 provider 的 429/认证失败与订阅 key 无关。
    providerPrefix: 'opencode-go',
    slotRefs: { a: 'OPENCODE_GO_POOL_A', b: 'OPENCODE_GO_POOL_B' },
    // 只认「reached limit」：额度打满才轮转，限流/网络/认证错误不切。
    rotateOnMessage: '',
    // 失败槽冷却：llm-retry 同一 step 最多重试 20 次，没有冷却两把 key 会来回横跳。
    cooldownMs: 300_000,
    // 控制台用量凭据目录；每个槽一个 <slot>.json（workspaceId + authCookie + sessionCookie）。
    quotaDir: '',
    // 用量抓取的缓存时间。
    quotaCacheTtl: 60_000
};

const SLOT_NAMES = ['a', 'b'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// 「reached limit」判据：reached 与 limit 相距不超过 40 字符（容忍 "reached your usage limit"、
// "reached the 5-hour limit" 这类措辞），但排除限流（rate limit / too many requests）——
// 限流不是额度打满，不该换 key。
const ROTATE_PATTERN = /reached[^.]{0,40}limit|limit[^.]{0,40}reached/i;
const NOT_ROTATE_PATTERN = /rate[ -]?limit|too many requests/i;
const METER_MAP = [
    { key: 'rolling', field: 'fiveHour' },
    { key: 'weekly', field: 'week' },
    { key: 'monthly', field: 'month' }
];

function configHome() {
    return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}

function dshHome() {
    return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 直接读凭据文件 refs 段的只读兜底；写一律走凭据服务。 */
function readCredentialFile(ref) {
    const file = join(dshHome(), '.credentials.yaml');
    if (!existsSync(file)) return '';
    const pattern = new RegExp(`^\\s{1,4}${escapeRegExp(ref)}\\s*:\\s*["']?([^"'\\r\\n]+)`, 'm');
    const matched = pattern.exec(readFileSync(file, 'utf8'));
    return matched ? matched[1].trim() : '';
}

function loadState() {
    const file = join(dshHome(), 'opencode-go-pool.json');
    if (!existsSync(file)) return { active: 'a', slots: {}, updatedAt: null };
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return {
            active: parsed?.active === 'b' ? 'b' : 'a',
            slots: typeof parsed?.slots === 'object' && parsed.slots !== null ? parsed.slots : {},
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
        };
    } catch {
        return { active: 'a', slots: {}, updatedAt: null };
    }
}

function saveState(state) {
    const file = join(dshHome(), 'opencode-go-pool.json');
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
}

function durationText(seconds) {
    const value = Math.max(0, Math.round(seconds));
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function bigintPercent(used, limit) {
    try {
        const numerator = BigInt(String(used));
        const denominator = BigInt(String(limit));
        if (denominator <= 0n) return 0;
        return Number((numerator * 10000n) / denominator) / 100;
    } catch {
        return 0;
    }
}

/** 把控制台 /console/api/go/status 的 meters 归一成条形的窗口数组（口径：剩余百分比）。 */
function parseMeters(payload) {
    const access = payload?.access;
    const meters = access?.meters;
    if (!meters) return { windows: [], reason: 'no-meters' };
    const windows = [];
    const now = Date.now();
    for (const meter of METER_MAP) {
        const window = meters[meter.field];
        if (!window || window.usedMicroCents === undefined || window.limitMicroCents === undefined) continue;
        const percent = bigintPercent(window.usedMicroCents, window.limitMicroCents);
        const resetsAt = window.resetsAt ?? access.endsAt ?? null;
        const seconds = resetsAt ? Math.max(0, Math.round((Date.parse(resetsAt) - now) / 1000)) : 0;
        windows.push({
            key: meter.key,
            remainingPercent: Math.max(0, 100 - percent),
            resetInSeconds: seconds,
            resetText: durationText(seconds),
            resetsAt
        });
    }
    return { windows, reason: windows.length === 0 ? 'empty-meters' : null };
}

/** 分模型 token 构成（近 30 天），与三窗口同后端、同凭据。 */
function parseModelUsage(payload) {
    const items = Array.isArray(payload?.items) ? payload.items : null;
    if (!items) return { models: [], reason: 'no-items' };
    const rows = [];
    for (const item of items) {
        const toCount = (value) => {
            try { return BigInt(String(value ?? 0)); } catch { return 0n; }
        };
        const total = toCount(item.totalInputTokens) + toCount(item.totalOutputTokens) + toCount(item.totalCacheReadTokens)
            + toCount(item.totalCacheWrite5mTokens) + toCount(item.totalCacheWrite1hTokens);
        if (total <= 0n) continue;
        rows.push({ provider: item.provider ?? '', model: item.model ?? '', tokens: total, totalTokens: total.toString(), costMicroCents: String(item.totalCostMicroCents ?? '0') });
    }
    if (rows.length === 0) return { models: [], reason: 'empty-models' };
    rows.sort((left, right) => (left.tokens < right.tokens ? 1 : left.tokens > right.tokens ? -1 : 0));
    let sum = 0n;
    for (const row of rows) sum += row.tokens;
    const models = rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        totalTokens: row.totalTokens,
        costMicroCents: row.costMicroCents,
        sharePercent: Number((row.tokens * 10000n) / sum) / 100
    }));
    return { models, totalTokens: sum.toString() };
}

// ---- 新通道（2026-11-17）：官方 /zen/go/v1/usage，用本机 OpenCode Go key 认证 -------------
// 与 pool 插件同源（~/.dsh/.credentials.yaml 的 OPENCODE_GO_API_KEY），不依赖浏览器 cookie。
// console/api/go/status 在 2026 改版后要求 __Host-console_session 与 x-org-id，旧 cookie 一律 401/400。
const ZEN_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const ZEN_METER_MAP = [
    { key: 'rolling', field: 'rolling' },
    { key: 'weekly', field: 'weekly' },
    { key: 'monthly', field: 'monthly' }
];

function parseZenUsage(payload) {
    const usage = payload?.usage;
    if (!usage) return { windows: [], reason: 'no-usage', head: JSON.stringify(payload ?? {}).slice(0, 200) };
    const windows = [];
    const now = Date.now();
    for (const meter of ZEN_METER_MAP) {
        const window = usage[meter.field];
        if (!window || typeof window.percent !== 'number') continue;
        const resetsAt = window.resetsAt ?? null;
        // 官方文档的 Meter.resetsAt 是「毫秒时间戳」，issue 实测也出现过 ISO 串；两种都收。
        const resetMs = typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt);
        const seconds = Number.isFinite(resetMs) ? Math.max(0, Math.round((resetMs - now) / 1000)) : 0;
        windows.push({
            key: meter.key,
            remainingPercent: Math.max(0, 100 - window.percent),
            resetInSeconds: seconds,
            resetText: durationText(seconds),
            resetsAt
        });
    }
    return { windows, reason: windows.length > 0 ? null : 'empty-usage' };
}

async function fetchViaZenKey(activeRef) {
    const key = readCredentialFile(activeRef);
    if (!key) return { err: 'no-pool-key' };
    // 用 fetch 而不是 curl.exe：key 只进进程内 header，不出现在进程命令行（Windows 任何同用户进程可读 Win32_Process.CommandLine）。
    try {
        const res = await fetch(ZEN_USAGE_URL, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) return { err: `http-${res.status}` };
        return { json: await res.json() };
    } catch (error) {
        return { err: String(error?.message ?? error) };
    }
}

// 本地 token 记录换成 DSH 会话日志：opencode CLI 的 SQLite（~/.local/share/opencode/opencode.db）
// 本机最后写入停在 2026-09-26，DSH 用得再多它也不动，是死数据。新实现在 apply 内
// （readSessionUsage / readSessionUsageCached），读 <DSH_HOME>/sessions/**/session.*.jsonl.zstd。

/**
 * Cordis 插件入口：挂 llm/stream 拦截、维护槽位状态、注册用量与轮转路由。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [rawConfig] - cordis.patch.yml 里的 config。
 */
export function apply(ctx, rawConfig) {
    const options = { ...DEFAULTS, ...(rawConfig ?? {}) };
    const slotRefs = { a: DEFAULTS.slotRefs.a, b: DEFAULTS.slotRefs.b, ...(options.slotRefs ?? {}) };
    const rotatePattern = options.rotateOnMessage ? new RegExp(options.rotateOnMessage, 'i') : ROTATE_PATTERN;
    const quotaDir = options.quotaDir || join(configHome(), 'opencode-go-quota-pool');
    const state = loadState();
    const log = (message) => ctx.logger?.info?.(`opencode-go-quota-pool: ${message}`);
    const quotaCache = new Map();
    let credentials = null;

    ctx.inject(['credentials'], (sub) => {
        credentials = sub.get?.('credentials') ?? sub.credentials ?? null;
        if (credentials) void ensureSlotA().catch((error) => log(`seed slot a failed: ${error.message}`));
    });

    async function resolveRef(ref) {
        try {
            if (credentials) {
                const resolved = await credentials.resolve(ref);
                if (resolved && typeof resolved.value === 'string' && resolved.value.length > 0) return resolved.value;
            }
        } catch { /* 服务未就绪时落到文件兜底 */ }
        return readCredentialFile(ref);
    }

    async function setKey(ref, value) {
        if (!credentials) throw new Error('credentials service unavailable; cannot switch key');
        await credentials.set(ref, value);
    }

    /** 首次启动把生效引用的现有 key 迁进槽 A；幂等。 */
    async function ensureSlotA() {
        if (await resolveRef(slotRefs.a)) return;
        const active = await resolveRef(options.activeRef);
        if (!active) return;
        await setKey(slotRefs.a, active);
        state.slots.a = { ...(state.slots.a ?? {}), migratedAt: new Date().toISOString() };
        saveState(state);
        log('seeded slot a from the active credential');
    }

    const otherSlot = (slot) => (slot === 'a' ? 'b' : 'a');

    async function switchTo(slot, reason) {
        if (!SLOT_NAMES.includes(slot)) throw new Error(`unknown slot: ${slot}`);
        if (slot === state.active) return { changed: false, slot };
        const key = await resolveRef(slotRefs[slot]);
        if (!key) throw new Error(`no key stored for slot ${slot} (${slotRefs[slot]})`);
        await setKey(options.activeRef, key);
        state.active = slot;
        state.updatedAt = new Date().toISOString();
        state.slots[slot] = { ...(state.slots[slot] ?? {}), lastSwitchedAt: state.updatedAt, reason: reason ?? null };
        saveState(state);
        log(`switched to slot ${slot} (${reason ?? 'manual'})`);
        return { changed: true, slot };
    }

    function shouldRotate(failure) {
        const message = typeof failure?.message === 'string' ? failure.message : '';
        return message.length > 0 && rotatePattern.test(message) && !NOT_ROTATE_PATTERN.test(message);
    }

    async function rotateIfPossible(failure) {
        if (!shouldRotate(failure)) return false;
        const target = otherSlot(state.active);
        const now = Date.now();
        const coolingUntil = typeof state.slots[target]?.cooldownUntil === 'string'
            ? Date.parse(state.slots[target].cooldownUntil)
            : 0;
        if (Number.isFinite(coolingUntil) && coolingUntil > now) {
            log(`skip rotation to slot ${target}: cooling until ${new Date(coolingUntil).toISOString()}`);
            return false;
        }
        const key = await resolveRef(slotRefs[target]).catch(() => '');
        if (!key) {
            log(`cannot rotate to slot ${target}: no key stored for ${slotRefs[target]}`);
            return false;
        }
        try {
            const failedSlot = state.active;
            const message = String(failure?.message ?? '').slice(0, 80);
            await switchTo(target, `reached-limit: ${message}`);
            state.slots[failedSlot] = {
                ...(state.slots[failedSlot] ?? {}),
                lastFailureAt: new Date(now).toISOString(),
                cooldownUntil: new Date(now + (options.cooldownMs ?? DEFAULTS.cooldownMs)).toISOString()
            };
            saveState(state);
            return true;
        } catch (error) {
            log(`rotate to slot ${target} failed: ${error.message}`);
            return false;
        }
    }

    // llm/stream：只检测 + 切凭据，不重试；只处理 opencode-go 路由。
    ctx.on('llm/stream', (request, next) => {
        const provider = typeof request?.provider === 'string' ? request.provider : '';
        if (!provider.startsWith(options.providerPrefix ?? 'opencode-go')) return next();
        return (async function* () {
            for await (const chunk of next()) {
                if (chunk?.type !== 'finish') {
                    yield chunk;
                    continue;
                }
                if (chunk.reason?.kind === 'error') {
                    await rotateIfPossible(chunk.reason.failure ?? { message: '' })
                        .catch((error) => log(`rotate failed: ${error.message}`));
                }
                yield chunk;
                return;
            }
        })();
    });

    // ---- 用量抓取（控制台 cookie 通道）------------------------------------

    function credentialFileOf(slot) {
        const envKey = slot === 'a' ? 'OPENCODE_GO_QUOTA_A_FILE' : 'OPENCODE_GO_QUOTA_B_FILE';
        if (process.env[envKey]) return process.env[envKey];
        return join(quotaDir, `${slot}.json`);
    }

    function loadQuotaCredentials(slot) {
        const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID ?? '';
        const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE ?? '';
        const sessionCookie = process.env.OPENCODE_GO_SESSION_COOKIE ?? '';
        if (workspaceId && authCookie) return { workspaceId, authCookie, sessionCookie, source: 'environment' };
        const file = credentialFileOf(slot);
        if (!existsSync(file)) return null;
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8'));
            const workspace = parsed.workspaceId ?? parsed.workspaceID ?? parsed.workspace_id ?? parsed.orgId ?? parsed.org_id ?? '';
            const auth = parsed.authCookie ?? parsed.auth_cookie ?? parsed.cookie ?? '';
            const session = parsed.sessionCookie ?? parsed.session_cookie ?? '';
            if (workspace && auth) return { workspaceId: workspace, authCookie: auth, sessionCookie: session, source: file };
        } catch { /* 坏文件当作没有 */ }
        return null;
    }

    function curlGet(url, headers, timeoutMs = 20000) {
        return new Promise((resolve) => {
            const args = ['-sS', '-L', '--max-time', String(Math.ceil(timeoutMs / 1000)),
                '-H', 'Accept: application/json',
                '-H', `User-Agent: ${UA}`];
            for (const header of headers) args.push('-H', header);
            args.push(url);
            execFile('curl.exe', args, { timeout: timeoutMs + 3000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
                if (error) resolve({ err: String(error.message ?? error) });
                else resolve({ body: stdout });
            });
        });
    }

    function requestHeaders(creds) {
        const auth = creds.authCookie.startsWith('auth=') ? creds.authCookie : `auth=${creds.authCookie}`;
        const cookieHeader = creds.sessionCookie ? `${auth}; ${creds.sessionCookie}` : auth;
        return [
            `Cookie: ${cookieHeader}`,
            `x-org-id: ${creds.workspaceId}`,
            'Referer: https://opencode.ai/console/go',
            'Origin: https://opencode.ai'
        ];
    }

    async function getJson(url, headers) {
        const res = await curlGet(url, headers);
        if (res.err) return { err: String(res.err).slice(0, 300) };
        try {
            return { json: JSON.parse((res.body ?? '').trim()) };
        } catch {
            return { err: 'bad-json', head: (res.body ?? '').slice(0, 200) };
        }
    }

    // ---- 近 30 天分模型 token 构成 -----------------------------------------
    // DSH 没有导出 usage 的通道：全量数据只在 <DSH_HOME>/sessions/**/session.*.jsonl.zstd，
    // 投影缓存里的 tokenUsage.totals 只有聚合值（官方讨论 #5624 的口径）。所以自己解日志：
    // 每个文件是多帧 zstd、一帧一条事件，取 assistant/message 的 usage（provider 报回的真数），
    // 模型归属取同一条消息的 source.model。按天分桶落盘，文件 mtimeNs + size 没变就复用。
    // 以前抓 console/api/usage/models?range=30d —— 那条要浏览器 cookie（__Host-console_session
    // 与 x-org-id），console 改版后本机拿不到，永远是 not-fetched。

    const USAGE_WINDOW_DAYS = 30;
    const USAGE_SCAN_CONCURRENCY = 4;
    const USAGE_CACHE_VERSION = 2;
    const USAGE_TTL = 10 * 60_000;
    const USAGE_WAIT_MS = 8_000;
    const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

    let usageCache = { at: 0, data: null, pending: null };

    function usageCachePath() {
        return join(dshHome(), 'plugins', 'quota-bars', 'usage-30d.json');
    }

    /** 异步解压走 libuv 线程池：400 MB 全量同步解会把宿主主线程钉住二十秒。 */
    function zstdAsync(buffer) {
        return new Promise((resolve, reject) => {
            zstdDecompress(buffer, (error, out) => (error ? reject(error) : resolve(out)));
        });
    }

    /** 一个会话文件 → { days, failedFrames }；days 是 { "YYYY-MM-DD": { model: tokens } }。 */
    async function readSessionFile(file, since) {
        const buffer = await fsp.readFile(file);
        // 多帧 zstd：帧起点按魔数扫（indexOf 比逐字节快三倍多），每帧只吃自己的字节。
        // Node 24 的整包解压只解第一帧，所以必须自己切。
        const starts = [];
        for (let at = buffer.indexOf(ZSTD_MAGIC); at >= 0; at = buffer.indexOf(ZSTD_MAGIC, at + 4)) starts.push(at);
        const days = new Map();
        let failedFrames = 0;
        for (let i = 0; i < starts.length; i += 1) {
            const end = i + 1 < starts.length ? starts[i + 1] : buffer.length;
            let text;
            try { text = (await zstdAsync(buffer.subarray(starts[i], end))).toString('utf8'); } catch { failedFrames += 1; continue; }
            for (const line of text.split('\n')) {
                if (!line) continue;
                let event;
                try { event = JSON.parse(line); } catch { continue; }
                if (event.type !== 'assistant/message' || (event.time ?? 0) < since) continue;
                const usage = event.data?.usage;
                if (!usage) continue;
                const tokens = Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0)
                    + Number(usage.reasoningTokens ?? 0) + Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheWriteTokens ?? 0);
                if (!Number.isFinite(tokens) || tokens <= 0) continue;
                const model = event.data?.message?.source?.model ?? 'unknown';
                const day = new Date(event.time).toISOString().slice(0, 10);
                let bucket = days.get(day);
                if (!bucket) { bucket = new Map(); days.set(day, bucket); }
                bucket.set(model, (bucket.get(model) ?? 0) + tokens);
            }
        }
        const flat = {};
        for (const [day, bucket] of days) {
            const models = {};
            for (const [model, tokens] of bucket) models[model] = tokens;
            flat[day] = models;
        }
        return { days: flat, failedFrames };
    }

    /** 会话文件名的版本号：session.jsonl.zstd 记 0，session.v4.jsonl.zstd 记 4，其它 -1。 */
    function sessionFileVersion(name) {
        const match = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(name);
        return match ? Number(match[1] ?? 0) : -1;
    }

    /**
     * 30 天内动过的会话文件。老会话若还在用，mtime 会刷新，不会漏。
     * 同一目录可能并存多份（session.jsonl.zstd 与 session.v3.jsonl.zstd），两份含重叠的
     * assistant/message —— 只取版本号最高的那份，否则同一批消息会被算两次。
     */
    async function listSessionFiles(root, since) {
        const picked = new Map();
        const walk = async (dir) => {
            let entries;
            try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) { await walk(full); continue; }
                if (!entry.isFile()) continue;
                const version = sessionFileVersion(entry.name);
                if (version < 0) continue;
                const current = picked.get(dir);
                if (!current || version > current.version) picked.set(dir, { path: full, version });
            }
        };
        await walk(root);
        const out = [];
        for (const { path: file } of picked.values()) {
            let stat;
            try { stat = await fsp.stat(file, { bigint: true }); } catch { continue; }
            if (Number(stat.mtimeMs) < since) continue;
            // mtimeNs 用 BigInt 取：mtimeMs 是 double，两次相隔 100–244 ns 的写入会落成同一个值。
            out.push({ path: file, mtimeNs: stat.mtimeNs.toString(), size: Number(stat.size) });
        }
        return out;
    }

    async function readSessionUsage() {
        const since = Date.now() - USAGE_WINDOW_DAYS * 86400_000;
        const files = await listSessionFiles(join(dshHome(), 'sessions'), since);
        let previous = null;
        try { previous = JSON.parse(await fsp.readFile(usageCachePath(), 'utf8')); } catch {}
        const known = previous && previous.version === USAGE_CACHE_VERSION && previous.files ? previous.files : {};
        const next = { version: USAGE_CACHE_VERSION, files: {} };
        let failedFrames = 0;
        let cursor = 0;
        const scan = async () => {
            while (cursor < files.length) {
                const file = files[cursor++];
                const hit = known[file.path];
                if (hit && hit.mtimeNs === file.mtimeNs && hit.size === file.size) { next.files[file.path] = hit; continue; }
                const parsed = await readSessionFile(file.path, since);
                failedFrames += parsed.failedFrames;
                next.files[file.path] = { mtimeNs: file.mtimeNs, size: file.size, days: parsed.days };
            }
        };
        await Promise.all(Array.from({ length: Math.min(USAGE_SCAN_CONCURRENCY, files.length) }, scan));
        // 一个文件都没列出来 == 读盘出了问题，不是「没有用量」。合计为 0 同理：这时候不写盘，
        // 别拿空结果盖掉好缓存。
        if (files.length === 0) return { ok: false, reason: 'scan-empty', detail: '会话目录一个文件都没列出' };
        const floor = Date.parse(new Date(since).toISOString().slice(0, 10));
        const byModel = new Map();
        let total = 0;
        for (const entry of Object.values(next.files)) {
            for (const [day, models] of Object.entries(entry.days ?? {})) {
                if (Date.parse(day) < floor) continue;
                for (const [model, tokens] of Object.entries(models)) {
                    const value = Number(tokens) || 0;
                    if (value <= 0) continue;
                    byModel.set(model, (byModel.get(model) ?? 0) + value);
                    total += value;
                }
            }
        }
        if (total === 0) return { ok: false, reason: 'no-records', detail: '近 30 天会话里没有 usage 记录', failedFrames };
        // 顺手把窗口外的天剔掉，缓存别一直长。
        for (const [file, entry] of Object.entries(next.files)) {
            for (const day of Object.keys(entry.days ?? {})) {
                if (Date.parse(day) < floor) delete entry.days[day];
            }
            if (Object.keys(entry.days ?? {}).length === 0) delete next.files[file];
        }
        try {
            await fsp.mkdir(join(dshHome(), 'plugins', 'quota-bars'), { recursive: true });
            await fsp.writeFile(usageCachePath(), JSON.stringify(next));
        } catch {}
        const models = [...byModel.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([model, tokens]) => ({
                model,
                provider: '',
                totalTokens: String(tokens),
                sharePercent: Number((tokens * 10000) / total) / 100
            }));
        return { ok: true, models, totalTokens: String(total), windowDays: USAGE_WINDOW_DAYS, source: 'dsh-sessions', failedFrames };
    }

    /** 10 分钟缓存 + 单飞；首次扫盘最多等 8 秒，超时先回 warming，算完下一轮就有。 */
    async function readSessionUsageCached(onDone) {
        if (usageCache.data && Date.now() - usageCache.at < USAGE_TTL) return usageCache.data;
        if (!usageCache.pending) {
            usageCache.pending = readSessionUsage().then((data) => {
                usageCache = { at: Date.now(), data, pending: null };
                if (onDone) onDone(data);
                return data;
            }).catch((error) => {
                // 不清 pending 的话，每次轮询都拿到同一个 rejected promise，这一条永久失效。
                usageCache.pending = null;
                return { ok: false, reason: 'scan-failed', detail: String(error?.message ?? error) };
            });
        }
        const timeout = new Promise((resolve) => setTimeout(() => resolve(null), USAGE_WAIT_MS));
        const raced = await Promise.race([usageCache.pending, timeout]);
        if (raced) return raced;
        return usageCache.data ?? { ok: false, reason: 'warming', detail: '首次统计还在跑，下一轮轮询就有数' };
    }

    /**
     * 抓某个槽所属账号的用量；结果按槽缓存 TTL 秒。
     * 缓存按 workspace 隔离，避免槽间串数据。
     */
    async function fetchUsage(slot) {
        const cached = quotaCache.get(slot);
        if (cached && Date.now() - cached.at < (options.quotaCacheTtl ?? DEFAULTS.quotaCacheTtl)) return cached.data;
        // 通道 1（优先）：官方 usage 接口，key 认证，不依赖浏览器 cookie。
        const zen = await fetchViaZenKey(options.activeRef);
        if (!zen.err) {
            const parsed = parseZenUsage(zen.json);
            if (parsed.windows.length > 0) {
                const data = { ok: true, windows: parsed.windows, usageMonth: await readSessionUsageCached(), source: 'zen-usage-key', slot };
                quotaCache.set(slot, { at: Date.now(), data });
                return data;
            }
        }
        // 通道 2（回退）：控制台 cookie 通道。
        const creds = loadQuotaCredentials(slot);
        if (!creds) {
            const data = { ok: false, reason: 'no-credentials', slot };
            quotaCache.set(slot, { at: Date.now(), data });
            return data;
        }
        const headers = requestHeaders(creds);
        const status = await getJson('https://opencode.ai/console/api/go/status', headers);
        if (status.err) return { ok: false, reason: 'dashboard-error', detail: status.err, slot };
        if (status.json?._tag) return { ok: false, reason: 'api-error', detail: JSON.stringify(status.json).slice(0, 300), slot };
        const { windows, reason } = parseMeters(status.json);
        if (windows.length === 0) return { ok: false, reason: reason ?? 'no-windows', slot };
        const usageMonth = await readSessionUsageCached();
        const data = { ok: true, windows, usageMonth, source: creds.source, slot };
        quotaCache.set(slot, { at: Date.now(), data });
        return data;
    }

    /** 当前生效槽的用量（client 的条据此显示）。 */
    async function currentUsage() {
        return fetchUsage(state.active);
    }

    // ---- web 路由 ---------------------------------------------------------

    ctx.inject(['webServer'], (sub) => {
        const webServer = sub.get?.('webServer') ?? sub.webServer;
        if (!webServer) return;
        const reply = (res, status, body) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(body));
        };
        const readBody = (req) => new Promise((resolve, reject) => {
            const chunks = [];
            req.on('data', (chunk) => {
                chunks.push(chunk);
                if (Buffer.concat(chunks).length > 64 * 1024) reject(new Error('body too large'));
            });
            req.on('end', () => {
                try { resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
                catch (error) { reject(error); }
            });
            req.on('error', reject);
        });

        const disposers = [
            webServer.register({
                kind: 'prefix',
                path: '/api/quota/opencode-go',
                handler: async (req, res) => {
                    try {
                        reply(res, 200, await currentUsage());
                    } catch (error) {
                        reply(res, 500, { ok: false, reason: 'internal', detail: String(error?.message ?? error) });
                    }
                }
            }),
            webServer.register({
                kind: 'prefix',
                path: '/plugins/opencode-go-pool',
                handler: async (req, res) => {
                    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
                    try {
                        if (req.method === 'GET' && url.pathname === '/plugins/opencode-go-pool/status') {
                            const usage = await currentUsage().catch((error) => ({ ok: false, reason: 'internal', detail: String(error?.message ?? error) }));
                            const slots = {};
                            for (const slot of SLOT_NAMES) {
                                const key = await resolveRef(slotRefs[slot]).catch(() => '');
                                slots[slot] = {
                                    ref: slotRefs[slot],
                                    configured: key.length > 0,
                                    ...(state.slots[slot] ?? {})
                                };
                            }
                            reply(res, 200, { active: state.active, slots, usage, updatedAt: state.updatedAt });
                            return;
                        }
                        if (req.method === 'POST' && url.pathname === '/plugins/opencode-go-pool/switch') {
                            const body = await readBody(req);
                            reply(res, 200, await switchTo(String(body.slot ?? ''), 'manual'));
                            return;
                        }
                        if (req.method === 'POST' && url.pathname === '/plugins/opencode-go-pool/set') {
                            const body = await readBody(req);
                            const slot = String(body.slot ?? '');
                            const key = typeof body.key === 'string' ? body.key.trim() : '';
                            if (!SLOT_NAMES.includes(slot)) throw new Error(`unknown slot: ${slot}`);
                            if (key.length === 0) throw new Error('key is empty');
                            await setKey(slotRefs[slot], key);
                            reply(res, 200, { ok: true, slot, ref: slotRefs[slot] });
                            return;
                        }
                        reply(res, 404, { error: 'not found' });
                    } catch (error) {
                        reply(res, 400, { error: String(error?.message ?? error) });
                    }
                }
            })
        ];
        return () => {
            for (const dispose of disposers) {
                try { dispose?.(); } catch { /* 已卸载 */ }
            }
        };
    });
}

/** 纯函数出口：方便本地回归直接测用量与判据解析。 */
export const _internal = { parseMeters, parseModelUsage, parseZenUsage, rotatePattern: ROTATE_PATTERN };
