// sync-core.js
// 加密、版本化的共享状态核心 —— 供 Skill4 网页和搭子 App 共用。
// 同时运行在浏览器与 Node（测试）。加密走 Web Crypto（AES-256-GCM）。
//
// 共享状态只含「计划完成状态 + 学习时长 + 日报」，不含聊天记录。
// 上传到 GitHub 的只有密文，明文永不落库。

const SCHEMA_VERSION = 1;
const ALGORITHM = 'A256GCM';
const SYNC_PATH = 'sync/v1/state.json';
const DEFAULT_REPO = '00m-k/skill4';

/** 返回一份全新的空共享状态。 */
function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    tasks: {},
    dailyReports: {},
  };
}

/**
 * 合并两份状态：同一任务 / 同一日期，取 updatedAt 更新的一方；
 * 互不相关的条目全部保留。revision / schemaVersion 取较大值。
 * 对称——左右顺序不影响内容结果。
 */
function mergeState(left, right) {
  const leftTasks = (left && left.tasks) || {};
  const rightTasks = (right && right.tasks) || {};
  const leftReports = (left && left.dailyReports) || {};
  const rightReports = (right && right.dailyReports) || {};

  const ts = (e) => (e && e.updatedAt) || ''; // 缺省按最旧处理

  const tasks = { ...leftTasks };
  for (const [id, entry] of Object.entries(rightTasks)) {
    const existing = tasks[id];
    if (!existing || ts(entry) > ts(existing)) {
      tasks[id] = entry;
    }
  }

  const dailyReports = { ...leftReports };
  for (const [date, entry] of Object.entries(rightReports)) {
    const existing = dailyReports[date];
    if (!existing || ts(entry) > ts(existing)) {
      dailyReports[date] = entry;
    }
  }

  return {
    schemaVersion: Math.max((left && left.schemaVersion) || SCHEMA_VERSION, (right && right.schemaVersion) || SCHEMA_VERSION),
    revision: Math.max((left && left.revision) || 0, (right && right.revision) || 0),
    tasks,
    dailyReports,
  };
}

// ---- base64（浏览器与 Node 通用）----

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000; // 分块避免大字符串导致的栈溢出
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- 加密 ----

function _rawKey(key) {
  return key instanceof Uint8Array ? key : base64ToBytes(key);
}

async function _importKey(key, cryptoImpl) {
  const c = cryptoImpl || globalThis.crypto;
  return c.subtle.importKey(
    'raw',
    _rawKey(key),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * 加密状态为信封。返回 {schemaVersion, algorithm, iv, ciphertext}，
 * 其中 iv / ciphertext 为 base64，序列化后不含任何明文。
 */
async function encodeEnvelope(state, key, cryptoImpl) {
  const c = cryptoImpl || globalThis.crypto;
  const iv = new Uint8Array(12);
  c.getRandomValues(iv);
  const cryptoKey = await _importKey(key, c);
  const plaintext = new TextEncoder().encode(JSON.stringify(state));
  const ciphertext = await c.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext);
  return {
    schemaVersion: SCHEMA_VERSION,
    algorithm: ALGORITHM,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * 解密信封，还原共享状态。密钥错误或密文被篡改时抛错（AES-GCM 自动校验）。
 */
async function decodeEnvelope(envelope, key, cryptoImpl) {
  const c = cryptoImpl || globalThis.crypto;
  const cryptoKey = await _importKey(key, c);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const plaintext = await c.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/**
 * 稳定任务 ID：日期/周/星期几/当天任务下标 组成。
 * 网页和搭子 App 用同一套计划导出即可算出相同 ID；显示文字仍由网页管理，ID 只用于同步。
 */
function taskIdFor(dateKey, week, dow, index) {
  return `${dateKey}/w${week}/d${dow}/i${index}`;
}

/**
 * 把网页旧 localStorage 里的明文数据（按日期+任务文字）迁入共享状态。
 * @param {Array} planExport  计划导出：[{ id, text, dateKey, week, dow, index }]
 * @param {Object} legacyDone  旧完成记录：{ [dateKey]: [taskText, ...] }
 * @param {Object} legacyEvenings 旧晚报：{ [dateKey]: {hours,summary,problem,tomorrow,savedAt} }
 * @param {string} [nowIso]    迁移时间戳（测试传固定值）
 */
function migrateToSharedState(planExport, legacyDone, legacyEvenings, nowIso) {
  const state = emptyState();
  const now = nowIso || new Date().toISOString();

  for (const item of planExport || []) {
    const doneTexts = (legacyDone && legacyDone[item.dateKey]) || [];
    if (doneTexts.includes(item.text)) {
      state.tasks[item.id] = { done: true, updatedAt: now, source: 'web' };
    }
  }

  for (const [date, e] of Object.entries(legacyEvenings || {})) {
    if (!e) continue;
    state.dailyReports[date] = {
      hours: e.hours || '0',
      summary: e.summary || '',
      problem: e.problem || '',
      tomorrow: e.tomorrow || '',
      updatedAt: e.savedAt || now,
    };
  }

  return state;
}

// ---- GitHub Contents 同步客户端 ----

class GitHubContentsSyncClient {
  constructor({ fetchImpl, tokenProvider, crypto: cryptoImpl, repo = DEFAULT_REPO } = {}) {
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.tokenProvider = tokenProvider || (() => null);
    this.crypto = cryptoImpl || globalThis.crypto;
    this.repo = repo;
    this.baseUrl = `https://api.github.com/repos/${repo}/contents/`;
  }

  _headers() {
    const token = this.tokenProvider();
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'skill4-sync',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /** 拉取远程状态。404（尚未创建）按空状态处理，不丢本地数据。 */
  async pull(key) {
    const res = await this.fetchImpl(this.baseUrl + SYNC_PATH, { headers: this._headers() });
    if (res.status === 404) {
      return { state: emptyState(), sha: null };
    }
    if (!res.ok) {
      throw new Error(`sync pull failed: HTTP ${res.status}`);
    }
    const file = await res.json();
    const raw = base64ToBytes((file.content || '').replace(/\s+/g, ''));
    const envelope = JSON.parse(new TextDecoder().decode(raw));
    const state = await decodeEnvelope(envelope, key, this.crypto);
    return { state, sha: file.sha };
  }

  /**
   * 上传状态。遇到 409（远程被并发修改）时，重新拉取、合并、重试一次；
   * 再失败则抛错，由上层保留本地待同步队列。
   */
  async push(state, sha, key) {
    const envelope = await encodeEnvelope(state, key, this.crypto);
    const content = bytesToBase64(new TextEncoder().encode(JSON.stringify(envelope)));
    const payload = { message: 'sync: update shared state', content };
    if (sha) payload.sha = sha;

    const res = await this.fetchImpl(this.baseUrl + SYNC_PATH, {
      method: 'PUT',
      headers: { ...this._headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.status === 409) {
      const pulled = await this.pull(key);
      const merged = mergeState(pulled.state, state);
      const mergedEnvelope = await encodeEnvelope(merged, key, this.crypto);
      const retryPayload = {
        message: 'sync: merge and update shared state',
        content: bytesToBase64(new TextEncoder().encode(JSON.stringify(mergedEnvelope))),
      };
      if (pulled.sha) retryPayload.sha = pulled.sha;
      const retryRes = await this.fetchImpl(this.baseUrl + SYNC_PATH, {
        method: 'PUT',
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(retryPayload),
      });
      if (!retryRes.ok) {
        throw new Error(`sync push conflict retry failed: HTTP ${retryRes.status}`);
      }
      const retryFile = await retryRes.json();
      return { state: merged, sha: retryFile.sha };
    }

    if (!res.ok) {
      throw new Error(`sync push failed: HTTP ${res.status}`);
    }
    const file = await res.json();
    return { state, sha: file.sha };
  }
}

export default {
  ALGORITHM,
  DEFAULT_REPO,
  SCHEMA_VERSION,
  SYNC_PATH,
  emptyState,
  mergeState,
  encodeEnvelope,
  decodeEnvelope,
  taskIdFor,
  migrateToSharedState,
  GitHubContentsSyncClient,
};
