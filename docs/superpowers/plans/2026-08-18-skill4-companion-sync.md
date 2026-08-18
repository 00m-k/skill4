# Skill4 × 搭子双向同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让网页 Skill4 和 Android 搭子安全共享计划完成状态、学习时长和日报，并让搭子的聊天、主动提醒基于这份状态工作。

**Architecture:** 静态计划继续由 Skill4 发布。所有可变学习状态使用同一份版本化 JSON，AES-256-GCM 加密后写入 GitHub Contents API 的 `sync/v1/state.json`；两端各自有本地加密缓存与待上传变更，按单项更新时间合并。聊天原文不上传。

**Tech Stack:** 浏览器 Web Crypto、GitHub Contents REST API、Kotlin/OkHttp/Retrofit、Android Keystore、kotlinx.serialization、Room、Compose、Node 内置 test、JUnit4。

## Global Constraints

- 任务必须有稳定 ID；不能用显示文字作为跨端唯一 ID。
- token、同步密钥、DeepSeek key 绝不写入源码、Git、日志、通知或模型提示词。
- 新日报不能继续写入公开 `data/*.json`，仅进入加密同步状态。
- 断网、404、冲突、密文损坏都不能清空本地状态。
- 对话只有精确匹配任务才能自动完成；含义不清楚时必须追问。
- Skill4 业务日期继续使用北京时间函数。

## Task 1: Browser shared state, merging and encryption

**Files:** Create `sync-core.js` and `sync-core.test.mjs` in `D:/Desktop/10skill/skill4`.

**Interfaces:** `emptyState()`, `mergeState(left,right)`, `encodeEnvelope(state,key)`, `decodeEnvelope(envelope,key)`, `GitHubContentsSyncClient.pull()` and `push(state,sha)`.

- [ ] **Step 1: Write failing tests**

Test that newest same-task timestamp wins, unrelated task changes survive, invalid keys/envelopes reject, 404 creates empty state, and a 409 performs exactly one pull/merge/PUT retry.

- [ ] **Step 2: Verify RED**

Run `node --test sync-core.test.mjs`. Expected: missing-module failure.

- [ ] **Step 3: Implement minimal core**

Define state as `{schemaVersion,revision,tasks,dailyReports}`. Pick the greater ISO timestamp per task ID/date. Encrypt UTF-8 JSON using a 32-byte base64 key, `AES-GCM`, and a fresh 12-byte IV. Return only `{schemaVersion:1,algorithm:'A256GCM',iv,ciphertext}`. Contents client treats 404 as empty and retries once after a 409 by pull/merge/PUT.

- [ ] **Step 4: Verify GREEN and commit**

Run `node --test sync-core.test.mjs`; expected PASS. Commit `feat: add encrypted Skill4 sync core`.

## Task 2: Bind the existing Skill4 webpage

**Files:** Modify `D:/Desktop/10skill/skill4/index.html`; create `D:/Desktop/10skill/skill4/docs/SKILL4_COMPANION_SYNC.md`.

**Interfaces:** `window.skill4SyncNow()` and `window.skill4ApplySharedState(state)`; existing `saveTask`, `saveEvening`, backlog refresh call `queueSharedSync()`.

- [ ] **Step 1: Write failing migration test**

Test that legacy `skill4_done_YYYY-MM-DD` date/text values migrate exactly once to their stable plan IDs and retain matching completion.

- [ ] **Step 2: Verify RED**

Run `node --test sync-core.test.mjs`; expected: migration helper missing.

- [ ] **Step 3: Implement integration**

Load `sync-core.js` before the inline script. Derive IDs from date/week/day/task-index plus a normalized subject token. Import legacy completion/report localStorage without deleting it. Add “搭子同步” settings: connection-code export/import, GitHub token, state, sync-now and disconnect. When connected, cease future raw `data/*.json` report uploads.

- [ ] **Step 4: Verify GREEN and commit**

Run `node --test sync-core.test.mjs`; expected PASS. In browser complete one task and save one report, reload, inspect remote payload and confirm it contains `ciphertext` but no report words. Commit `feat: sync Skill4 progress with companion`.

## Task 3: Android schema, crypto, token storage and GitHub client

**Files:** Create `Skill4Models.kt`, `Skill4Crypto.kt`, `GitHubSkill4SyncClient.kt` under `D:/Desktop/10skill/skill7/android/app/src/main/java/com/aifriend/app/data/skill4/`; create `SecureSkill4SyncStore.kt` under `security/`; create matching JUnit tests.

**Interfaces:** `Skill4State.merge`, `Skill4Crypto.encrypt/decrypt`, `Skill4SyncClient.pull/push`, `SecureSkill4SyncStore.read/write/clear`.

- [ ] **Step 1: Write failing tests**

Test Android/browser-compatible encryption with a fixed envelope, newest task merge, 409 retry with MockWebServer and secure-store clear.

- [ ] **Step 2: Verify RED**

Run `D:\Desktop\10skill\skill7\android\gradlew.bat :app:testDebugUnitTest --tests "*Skill4*"`; expected: missing-class compilation failure.

- [ ] **Step 3: Implement minimal interoperable behavior**

Use `AES/GCM/NoPadding`, 12-byte IV and browser field names. Add GitHub authorization only to `api.github.com`; logger redacts it. Store token/key/cache through existing `KeystoreCipher`; clear happens only after settings confirmation.

- [ ] **Step 4: Verify GREEN and commit**

Run the focused Skill4 and secure-store unit tests; expected PASS. Commit `feat: add secure Skill4 sync client`.

## Task 4: Android repository and settings

**Files:** Create `Skill4SyncRepository.kt`; modify `AppContainer.kt`, `SettingsScreen.kt`, `SettingsViewModel.kt`; create matching tests.

**Interfaces:** `state: StateFlow<Skill4State>`, `recordTask(taskId,done)`, `saveReport(date,patch)`, `syncNow()`, `studyContext()`.

- [ ] **Step 1: Write failing tests**

Test that an offline task mutation displays immediately and queues; study context exposes pending work but not credentials; disconnect clears all local sync secrets and shows disconnected.

- [ ] **Step 2: Verify RED**

Run `D:\Desktop\10skill\skill7\android\gradlew.bat :app:testDebugUnitTest --tests "*Skill4SyncRepositoryTest" --tests "*SettingsViewModelTest"`; expected: missing-class failure.

- [ ] **Step 3: Implement**

Persist mutations before networking. Sync after setup, explicit tap, app foreground and before proactive generation; ordinary chat remains usable after sync error. Settings copy is “连接 Skill4”、“同步状态”、“立即同步”、“断开并清除本机同步凭据”。 Connection code contains repository path and sync key only; GitHub token remains a separate local secret.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests; expected PASS. Commit `feat: connect companion settings to Skill4 sync`.

## Task 5: Use shared progress in chat and proactive messages

**Files:** Create `StudyProgressInterpreter.kt`; modify `LocalConversationRepository.kt`, `RecentContextBuilder.kt`, `ProactiveWorkerEngine.kt`; create matching tests.

**Interfaces:** `interpret(message,plan,now): MarkTask | UndoTask | ReportPatch | Ambiguous | None` and `repository.apply(intent)`.

- [ ] **Step 1: Write failing tests**

Test exact named task completion plus undo, ambiguous partial study without mutation, proactive prompt containing pending work/report summary, and prompt excluding credentials/full history.

- [ ] **Step 2: Verify RED**

Run `D:\Desktop\10skill\skill7\android\gradlew.bat :app:testDebugUnitTest --tests "*StudyProgressInterpreterTest" --tests "*Proactive*Test"`; expected: missing-class failure.

- [ ] **Step 3: Implement**

Use deterministic normalized exact-name matching first, not model-directed file edits. Exact match writes state and replies “记上了……不对就说撤回”；ambiguous text asks a short question. Add bounded study context before the existing latest-20 local chat turns. Proactive worker syncs best effort then uses cache.

- [ ] **Step 4: Verify GREEN and commit**

Run focused interpreter, repository and proactive tests; expected PASS. Commit `feat: use Skill4 progress in companion chats`.

## Task 6: Fix chat friction and release verification

**Files:** Modify `PhoneLocalChatViewModel.kt`, `PhoneLocalChatScreen.kt`, `CompanionPreferences.kt`, `SettingsScreen.kt` and matching tests.

- [ ] **Step 1: Write failing tests**

Test immediate visible draft clearing before deferred reply, retry retaining original pending content while draft stays editable, and preferences allowing six contacts while scheduler observes quiet hours.

- [ ] **Step 2: Verify RED then implement**

Run `D:\Desktop\10skill\skill7\android\gradlew.bat :app:testDebugUnitTest --tests "*PhoneLocalChatViewModelTest" --tests "*CompanionPreferencesTest" --tests "*ProactiveSchedulerTest"`; expected: failure on current delayed draft clearing and maximum 3 contacts.

Clear draft synchronously in `send()` while pending send retains original text for retry. Remove individual message cost from chat and show only optional aggregate use in settings. Support 1–6 proactive contacts using deterministic windows while preserving quiet hours/cooldowns.

- [ ] **Step 3: Final verification and commit**

Run `node --test D:\Desktop\10skill\skill4\sync-core.test.mjs`; expected PASS. Run `D:\Desktop\10skill\skill7\android\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:lintRelease :app:assembleRelease`; expected BUILD SUCCESSFUL. Scan changed source/APKs for secrets and a report phrase; none may appear. Manual phone acceptance: web-to-app task, app-to-web task, report sync, one offline change later recovered. Commit the code and the plan/design documents.

## Self-review

Tasks 1–2 create encrypted browser sync and migration. Tasks 3–4 build Android security, offline behavior and settings. Task 5 connects state to chat/proactive behavior without exporting chat history. Task 6 fixes the existing input/cost/contact-frequency concerns and validates debug/release builds. Every shared write has merge/non-loss behavior and every secret has an explicit exclusion check.
