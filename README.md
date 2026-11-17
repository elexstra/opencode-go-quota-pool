# opencode-go-quota-pool

OpenCode Go 双订阅轮转池 + 用量条，合并为一个 DeepSeek Harness（DSH）插件。

两个 API Key 分槽存放，**只在额度真的打满（API 返回「reached limit」）时**切到另一把；
输入框下方的用量条始终显示**当前生效槽位所属账号**的滚动 5 小时 / 每周 / 每月用量。

> English: An OpenCode Go dual-subscription round-robin pool with usage bars for DeepSeek Harness.
> Two API keys live in two slots; the plugin rotates only when the provider says the usage limit was
> reached, and the usage bars follow whichever slot is currently in effect.

## 功能

- **两槽轮转**：槽 A / 槽 B 各存一个稳定凭据引用，生效引用由插件改写，切槽后下一个请求立即用新 key。
- **只认 reached limit**：限流（429 RPM）、网络抖动、认证错误都不切——只有上游消息里出现 `reached limit` 才换槽，避免把可恢复的抖动当成额度耗尽。
- **用量条联动**：web 客户端在输入框下方画四根条（滚动 / 每周 / 每月 / 近 30 天分模型）。前三条来自当前槽位账号的控制台凭据，切槽后换账号显示；第四条读的是本机 DSH 自己的会话日志（`<DSH_HOME>/sessions/**/session.*.jsonl.zstd` 里 `assistant/message` 的 usage），不跟槽位走。
- **热迁移**：首次启动把生效引用里的现有 key 迁进槽 A；回切时原槽不动，随时切得回来。
- **本机管理面**：`/plugins/opencode-go-pool/status` 看状态与当前用量，`/switch`、`/set` 手动切换与写入 key。
- **不自行重试**：只切凭据，重试交给 llm-retry（同一 step 内重新 `prepareCall`、重新 resolve 凭据）。

## 安装

1. 把本仓库放进 DSH 的插件目录（或发布为 npm 包）。
2. 在 profile 的 `package.json` 加依赖与 bundle 条目：

```json
{
  "dependencies": {
    "opencode-go-quota-pool": "link:../opencode-go-quota-pool"
  },
  "dsh": {
    "profile": {
      "bundles": ["opencode-go-quota-pool"]
    }
  }
}
```

3. 在 profile 的 `cordis.patch.yml` 里配上（或直接改本包的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: opencode-go-quota-pool
      name: opencode-go-quota-pool
      config:
        activeRef: OPENCODE_GO_API_KEY
        slotRefs: { a: OPENCODE_GO_POOL_A, b: OPENCODE_GO_POOL_B }
        cooldownMs: 300000
```

4. 重启宿主，让清单里的新条目装载。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `activeRef` | `OPENCODE_GO_API_KEY` | 当前生效的凭据引用；opencode-go 的三条路由都应读它 |
| `slotRefs.a` / `.b` | `OPENCODE_GO_POOL_A` / `_B` | 两个订阅槽的稳定凭据引用 |
| `cooldownMs` | `300000` | 失败槽冷却；防 llm-retry 的重试在两把 key 间横跳 |
| `quotaDir` | `~/.config/opencode-go-quota-pool` | 控制台用量凭据目录，每槽一个 `<slot>.json` |
| `rotateOnMessage` | 空（用 `/reached\s+limit|limit\s+reached/i`） | 自定义「该轮转」的失败消息正则 |
| `quotaCacheTtl` | `60000` | 用量抓取缓存毫秒 |

### 用量凭据

用量来自 OpenCode 控制台，不是 API key：每槽一个 JSON。

```json
{
  "workspaceId": "<org 或 workspace id>",
  "authCookie": "<auth=... 或裸值>",
  "sessionCookie": "__Host-console_session=..."
}
```

放到 `~/.config/opencode-go-quota-pool/a.json`（槽 A）与 `b.json`（槽 B）；
或用环境变量 `OPENCODE_GO_QUOTA_A_FILE` / `OPENCODE_GO_QUOTA_B_FILE` 指向别的路径，
或统一用 `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`（仅单账号）。

### API Key

走 DSH 的凭据服务（`.credentials.yaml` 的 refs 层），不要写进本仓库：

```bash
# 写入槽 B 的 key（本机回环）
curl -X POST http://127.0.0.1:<webServer 端口>/plugins/opencode-go-pool/set \
  -H 'content-type: application/json' -d '{"slot":"b","key":"<key>"}'
```

## 轮转判据

只有一种情况会换槽：`llm/stream` 的失败 `finish` 里，`failure.message` 匹配
`reached\s+limit|limit\s+reached`（可用 `rotateOnMessage` 覆盖）。

- 限流、超时、认证失败、余额不足（`QUOTA` 但不含 reached limit 字样）都不切。
- 失败槽进入 `cooldownMs` 冷却，防止同一 step 的 20 次重试在两把 key 之间来回切。
- 两把 key 都打满时，错误原样透传，不掩盖故障。

## 兼容性

- DSH 0.2.2 / cordis 4.1.0：waterfall 的 `next()` 带一次性守卫，第二次调用抛 `next() called multiple times`；pi-ai 在失败前先 yield `usage`（重试会撞 `usage more than once`）。所以插件**只切凭据、不重试**，重试交给 llm-retry。
- 用量抓取走 `GET https://opencode.ai/console/api/go/status`（Cookie + `x-org-id`），响应 `access.meters.{fiveHour,week,month}` 的 `usedMicroCents` / `limitMicroCents`。

## 安全

- API key 只经 DSH 凭据服务读写，落在 `.credentials.yaml`；本仓库不存任何 key。
- 控制台 cookie 只存在于本机配置目录（`~/.config/opencode-go-quota-pool/`），
  管理路由只返回「配置与否」，不回显 cookie 或 key。
- `.gitignore` 已排除凭据文件与日志。

## 目录结构

```
lib/index.js     宿主半：轮转池 + 用量抓取 + 路由
lib/client.js    web 客户端半：输入框下方的用量条
locale/          条形的中英文案
cordis.patch.yml bundle 插入配置
verify.mjs       本地回归（不连网）
```

## 开发

```bash
node verify.mjs   # 轮转判据、冷却、迁移、直通的本地回归
```

## License

MIT
