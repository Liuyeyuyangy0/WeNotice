'use strict';

/**
 * 可选的 AI 语义二次判定层（OpenAI 兼容 /chat/completions）。
 * 只有在内置规则判为「仅列表 / 忽略」时才调用，用于补救关键词覆盖不到的语义通知；
 * 失败时静默降级，不影响主流程。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const ALLOWED_CATEGORIES = [
  'notice', 'mention', 'finance', 'logistics', 'security', 'schedule',
  'work', 'file', 'link', 'system', 'chat'
];

const SYSTEM_PROMPT = [
  '你是微信消息过滤器。判断一条微信消息是否属于「值得立刻提醒的通知类消息」。',
  '值得提醒：群公告/全员通知、@我、验证码/登录安全、转账/支付/账单、快递取件、会议/日程/面试/报名、合同/审批/交付等工作事务、收到的文件、重要链接。',
  '不值得提醒：普通闲聊、寒暄、表情、广告营销、新闻推送、情绪表达。',
  '只输出一个 JSON 对象，不要输出其他内容，格式：',
  '{"notice": true|false, "category": "notice|mention|finance|logistics|security|schedule|work|file|link|system|chat", "summary": "不超过40字的通知摘要", "reason": "不超过20字的判断依据"}'
].join('\n');

class AIClassifier {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.cache = new Map();
    this.queue = [];
    this.active = 0;
    this.maxConcurrent = 2;
    this.timeoutMs = 12000;
  }

  get config() {
    const cfg = this.getConfig() || {};
    return cfg.ai || {};
  }

  get enabled() {
    const cfg = this.config;
    return Boolean(cfg.enabled && cfg.apiKey && cfg.baseUrl && cfg.model);
  }

  /** 返回 Promise<result|null>，内部做并发限制与缓存 */
  classify(record) {
    if (!this.enabled) return Promise.resolve(null);
    const key = `${record.sessionName || ''}|${record.sender || ''}|${record.content || ''}`.slice(0, 500);
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));

    return new Promise((resolve) => {
      this.queue.push({ record, key, resolve });
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      this._run(job)
        .then((result) => {
          if (result) {
            if (this.cache.size > 800) this.cache.clear();
            this.cache.set(job.key, result);
          }
          job.resolve(result);
        })
        .catch(() => job.resolve(null))
        .finally(() => {
          this.active -= 1;
          this._drain();
        });
    }
  }

  async _run(job) {
    const cfg = this.config;
    const endpoint = `${String(cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const body = JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            `会话：${job.record.sessionName || '未知'}`,
            `发送者：${job.record.sender || '未知'}`,
            `消息内容：${String(job.record.content || '').slice(0, 800)}`
          ].join('\n')
        }
      ]
    });

    const text = await postJson(endpoint, cfg.apiKey, body, this.timeoutMs);
    const parsed = parseJsonLoose(text);
    if (!parsed || typeof parsed.notice !== 'boolean') return null;
    const category = ALLOWED_CATEGORIES.includes(parsed.category) ? parsed.category : 'notice';
    return {
      notice: parsed.notice,
      category,
      summary: String(parsed.summary || '').slice(0, 80),
      reason: String(parsed.reason || '').slice(0, 40)
    };
  }

  async test() {
    if (!this.enabled) return { ok: false, error: 'AI 未启用或缺少 API Key / 模型' };
    const started = Date.now();
    try {
      const result = await this._run({
        record: { sessionName: '测试群', sender: '测试', content: '【群公告】明天上午 9 点开会，请准时参加。' },
        key: 'test'
      });
      if (!result) return { ok: false, error: '模型返回内容无法解析为预期 JSON' };
      return { ok: true, elapsedMs: Date.now() - started, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

function postJson(endpoint, apiKey, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch (_err) {
      reject(new Error('AI 地址格式不正确'));
      return;
    }
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`AI 接口返回 HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            const data = JSON.parse(text);
            const content = data?.choices?.[0]?.message?.content;
            if (!content) {
              reject(new Error('AI 响应缺少 choices[0].message.content'));
              return;
            }
            resolve(content);
          } catch (err) {
            reject(new Error(`AI 响应不是 JSON: ${err.message}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('AI 请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseJsonLoose(text) {
  const raw = String(text || '').replace(/```json|```/g, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (_err) {
    return null;
  }
}

module.exports = { AIClassifier, parseJsonLoose };
