# Skill4 × 搭子 同步契约（Web 侧已实现，安卓侧照此对接）

> 本文档是两端互通的**唯一格式契约**。改任何一处的字段名/算法/路径，都必须同步改另一端，否则同步会静默失效。

## 一、GitHub 同步文件

| 路径 | 内容 | 加密 |
| --- | --- | --- |
| `sync/v1/state.json` | 可变学习状态（完成+时长+日报） | ✅ AES-256-GCM |
| `sync/v1/plan.json` | 带稳定 ID 的每日计划导出 | ❌ 公开（计划本就不敏感） |

仓库固定为 `00m-k/skill4`，分支 `main`。用 GitHub Contents API（`https://api.github.com/repos/00m-k/skill4/contents/...`），header 带 `Authorization: Bearer <fine-grained token>`（contents 读写权限）、`Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`。

## 二、加密信封（state.json 的内容）

`sync-core.js` 的 `encodeEnvelope` 产出，序列化为 JSON 后以 UTF-8 → base64 存入 GitHub 文件：

```json
{ "schemaVersion": 1, "algorithm": "A256GCM", "iv": "<base64 12字节>", "ciphertext": "<base64>" }
```

- 密钥：32 字节随机，base64url 后放进连接码；两端 AES-GCM 原样导入。
- 每次加密用全新 12 字节 IV（`crypto.getRandomValues`）。
- 解密失败（密钥错/密文被改）抛错，绝不能当作空状态或清空本地。

## 三、共享状态逻辑模型（解密后）

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "tasks": {
    "2026-08-18/w3/d1/i0": { "done": true, "updatedAt": "2026-08-18T13:20:00Z", "source": "web" }
  },
  "dailyReports": {
    "2026-08-18": { "hours": "3.5", "summary": "…", "problem": "…", "tomorrow": "…", "updatedAt": "2026-08-18T14:30:00Z" }
  }
}
```

合并规则（`mergeState`）：任务按 `id`、日报按日期，取 `updatedAt` 更大的一方；互不相关的都保留。`revision` 取较大值。`source` 取值 `web` | `companion`。

## 四、稳定任务 ID 与计划导出

- ID 格式：`<dateKey>/w<week>/d<dow>/i<index>`，如 `2026-08-18/w3/d1/i0`。
  - `dateKey` = 北京时间 `YYYY-MM-DD`；`week` 1–20；`dow` = JS `getDay()`（0=周日）；`index` = 当天任务数组下标（0 起）。
- 周锚点：`W1_START = 2026-08-03`（周一）。第 `w` 周周一 = `W1_START + (w-1)*7` 天；该周 `dow` 对应日期 = 周一 + `((dow+6)%7)` 天。
- `plan.json` 是 `_WEEK_TASKS` 的导出，数组每项：

```json
{ "id": "2026-08-18/w3/d1/i0", "text": "📖普心第9章 新课", "dateKey": "2026-08-18", "week": 3, "dow": 1, "index": 0 }
```

安卓侧必须**拉取 plan.json** 来把任务文字映射到 ID（不要自己硬编码计划）。显示文字始终由 skill4 网页管理，ID 只用于同步与冲突。

## 五、连接码

`skill4-sync://v1?repo=00m-k/skill4&key=<base64url(32字节)>`

- 网页「生成连接码」生成密钥并显示；手机 App 扫描/粘贴，用 Android Keystore 存密钥。
- base64url：`+`→`-`、`/`→`_`、去尾部 `=`。导入时还原并补齐 `=`。
- GitHub token 是**独立**的本机秘密，不进连接码。

## 六、交互约定（两端一致）

- 打开/生成主动消息前/发消息后尝试刷新；无网用最后成功缓存。
- 网页勾选任务、保存晚报 → 写本地 + 后台防抖 push（1.5s）。
- 无网更新不丢：本地状态缓存（web 为 `skill4_sync_state`）即待同步队列，联网后合并上传。
- 上传遇 409：重新 pull → merge → 重试**恰好一次**；再失败保留本地、提示用户。

## 七、隐私红线

- 聊天原文、GitHub token、同步密钥、DeepSeek key **绝不**进入 state.json、plan.json、提交记录、日志、或模型提示词。
- 新日报只进加密 state.json，不再写公开 `data/*.json`（旧历史清理需用户单独确认）。
