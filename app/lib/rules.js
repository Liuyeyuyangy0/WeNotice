'use strict';

/**
 * 通知分类与规则引擎。
 *
 * 设计目标：把「微信消息」分成三类动作：
 *   notify  桌面提醒 + 进入通知中心
 *   list    仅进入通知中心（重要但不打扰）
 *   ignore  只存档（普通聊天）
 *
 * 判定优先级：
 *   1. 系统事件（撤回等）
 *   2. 自己发出的消息 / 静音会话
 *   3. 用户自定义规则（按 priority 升序，先命中先得）
 *   4. 重点会话白名单
 *   5. 内置关键词 + 结构识别
 */

const CATEGORIES = {
  notice: { label: '公告通知', color: '#fbbf24', icon: 'megaphone' },
  mention: { label: '@我 / 全员', color: '#60a5fa', icon: 'at' },
  finance: { label: '交易财务', color: '#34d399', icon: 'wallet' },
  logistics: { label: '物流快递', color: '#22d3ee', icon: 'package' },
  security: { label: '安全验证', color: '#fb7185', icon: 'shield' },
  schedule: { label: '日程安排', color: '#c084fc', icon: 'calendar' },
  work: { label: '工作事务', color: '#818cf8', icon: 'briefcase' },
  file: { label: '文件', color: '#2dd4bf', icon: 'file' },
  link: { label: '链接', color: '#94a3b8', icon: 'link' },
  system: { label: '系统消息', color: '#94a3b8', icon: 'info' },
  chat: { label: '普通聊天', color: '#64748b', icon: 'chat' },
  custom: { label: '自定义', color: '#a78bfa', icon: 'sparkles' }
};

/**
 * 内置识别词库。
 * strong 命中直接提醒，weak 命中只进列表；同一分类取最高分。
 */
const KEYWORD_GROUPS = [
  {
    category: 'security',
    strong: ['验证码', '校验码', '动态码', '安全提醒', '异常登录', '身份验证', '登录验证', '设备验证', '激活码', '请勿泄露'],
    weak: ['验证', '校验', '安全', '密码']
  },
  {
    category: 'notice',
    strong: ['群公告', '@所有人', '@全体成员', '重要通知', '紧急通知', '开会通知', '放假通知', '停水通知', '停电通知', '停水', '停电', '群待办', '全体成员', '请注意'],
    weak: ['通知', '公告', '提醒', '安排', '调整', '变更', '检修', '搬迁', '更名', '迁移', '投票']
  },
  {
    category: 'mention',
    strong: ['@所有人', '@全体成员'],
    weak: []
  },
  {
    category: 'finance',
    strong: ['转账', '红包', '收款', '付款', '到账', '退款', '还款', '账单', '扣费', '扣款', '支付成功', '付款成功', '发票', '报销', '佣金', '提现', '充值', '订单', '交易'],
    weak: ['金额', '余额', '支付', '收款码']
  },
  {
    category: 'logistics',
    strong: ['快递', '取件码', '取件', '取货', '派送', '签收', '驿站', '包裹', '快递柜', '丰巢', '菜鸟', '物流', '已送达', '待取件', '运单'],
    weak: ['发货', '配送', '单号']
  },
  {
    category: 'schedule',
    strong: ['会议', '日程', '预约', '面试', '笔试', '报名', '签到', '开课', '上课', '直播', '截止', '腾讯会议', 'zoom', '钉钉会议', '活动时间', '提醒你', '日程提醒'],
    weak: ['时间', '地点', '安排', '议程', '培训']
  },
  {
    category: 'work',
    strong: ['审批', '请假', '周报', '月报', '报表', '合同', '签约', '归档', '工单', '上线', '版本发布', '排期', '汇报', '简历', '招聘', 'offer', '入职', '需求评审', '任务'],
    weak: ['项目', '需求', '文档', '进度', '同事', '部门']
  },
  {
    category: 'system',
    strong: ['好友申请', '新的朋友', '邀请你加入群聊', '你已被移出群聊', '群聊邀请', '撤回了一条消息', '拍一拍', '已通过你的好友申请', '以上是打招呼的内容'],
    weak: []
  }
];

const URL_RE = /https?:\/\/[^\s，。；、）)】]+/i;
const FILE_HINT_RE = /^\[(文件|文档|压缩包|PPT|Excel|PDF)\]$/;

function normalizeText(text) {
  return String(text || '')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 内置识别：返回 {category, action, reason, hits, score} */
function detectBuiltin(input) {
  const content = normalizeText(input.content);
  const raw = String(input.content || '');
  const mediaType = String(input.mediaType || '');
  const hits = [];

  let best = null;
  for (const group of KEYWORD_GROUPS) {
    let score = 0;
    let hitWord = '';
    for (const word of group.strong) {
      if (content.includes(word)) {
        score += 3;
        if (!hitWord) hitWord = word;
      }
    }
    for (const word of group.weak) {
      if (content.includes(word)) {
        score += 1;
        if (!hitWord) hitWord = word;
      }
    }
    if (score > 0) {
      hits.push({ category: group.category, word: hitWord, score });
      if (!best || score > best.score) best = { category: group.category, score, word: hitWord };
    }
  }

  // 自己发出去的引用/回复内容不参与强判定的情况由上层 isSend 处理，这里只做内容判断。

  if (best) {
    // @所有人 / 强安全类关键词无论分数多少都提醒
    const forceNotify = ['security', 'mention'].includes(best.category) || best.score >= 3;
    const action = forceNotify ? 'notify' : 'list';
    return {
      category: best.category,
      action,
      reason: `内置识别 · 命中「${best.word}」`,
      hits,
      score: best.score
    };
  }

  // 公众号文章 / 小程序 / 文件等 appmsg：标题已由 content.js 提取。
  // 标题命中了上面的词库就按更精确的分类走。
  // 公众号（official）的普通推文默认只归档，避免文章刷屏「通知中心」；
  // 群聊里分享的应用消息仍归入「链接」列表。
  if (String(input.kind || '') === 'appmsg') {
    if (input.sessionType === 'official') {
      return { category: 'link', action: 'ignore', reason: '公众号文章', hits, score: 0 };
    }
    return {
      category: 'link',
      action: 'list',
      reason: '应用消息 / 链接',
      hits,
      score: 1
    };
  }

  if (mediaType === 'file' || FILE_HINT_RE.test(content)) {
    return { category: 'file', action: 'list', reason: '文件消息', hits, score: 1 };
  }

  if (URL_RE.test(content)) {
    return { category: 'link', action: 'list', reason: '包含链接', hits, score: 1 };
  }

  if (mediaType === 'image' || mediaType === 'voice' || mediaType === 'video') {
    return { category: 'chat', action: 'ignore', reason: '媒体消息', hits, score: 0 };
  }

  return { category: 'chat', action: 'ignore', reason: '普通聊天', hits, score: 0 };
}

const ACTIONS = ['notify', 'list', 'ignore'];

function blankRule() {
  return {
    id: '',
    name: '',
    enabled: true,
    priority: 100,
    action: 'notify',
    category: 'notice',
    scope: 'all',
    anyKeywords: [],
    allKeywords: [],
    excludeKeywords: [],
    regex: '',
    senders: [],
    sessions: []
  };
}

function normalizeRule(rule) {
  const base = blankRule();
  const merged = Object.assign(base, rule || {});
  merged.id = String(merged.id || '');
  merged.name = String(merged.name || '').trim();
  merged.enabled = merged.enabled !== false;
  merged.priority = Number.isFinite(Number(merged.priority)) ? Number(merged.priority) : 100;
  merged.action = ACTIONS.includes(merged.action) ? merged.action : 'notify';
  merged.category = CATEGORIES[merged.category] ? merged.category : 'notice';
  merged.scope = ['all', 'group', 'private', 'official', 'service'].includes(merged.scope) ? merged.scope : 'all';
  for (const key of ['anyKeywords', 'allKeywords', 'excludeKeywords', 'senders', 'sessions']) {
    merged[key] = toStringList(merged[key]);
  }
  merged.regex = String(merged.regex || '').trim();
  return merged;
}

function toStringList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,，;；]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function sessionMatches(list, input) {
  if (!list.length) return false;
  const names = [input.sessionName, input.groupName, input.sourceName, input.sessionId]
    .filter(Boolean)
    .map((v) => String(v));
  return list.some((item) => names.some((name) => name === item || name.includes(item)));
}

function ruleMatches(rule, input) {
  const content = normalizeText(input.content);
  const sender = String(input.sender || '');
  const sessionName = String(input.sessionName || '');
  const sessionType = String(input.sessionType || 'other');

  if (rule.scope === 'group' && !['group', 'chatroom'].includes(sessionType)) return false;
  if (rule.scope === 'private' && sessionType !== 'private') return false;
  if (rule.scope === 'official' && sessionType !== 'official') return false;
  if (rule.scope === 'service' && !['service', 'official', 'system'].includes(sessionType)) return false;

  const hasCondition =
    rule.anyKeywords.length ||
    rule.allKeywords.length ||
    rule.excludeKeywords.length ||
    rule.regex ||
    rule.senders.length ||
    rule.sessions.length;
  if (!hasCondition) return false;

  if (rule.anyKeywords.length && !rule.anyKeywords.some((word) => content.includes(word))) return false;
  if (rule.allKeywords.length && !rule.allKeywords.every((word) => content.includes(word))) return false;
  if (rule.excludeKeywords.length && rule.excludeKeywords.some((word) => content.includes(word))) return false;

  if (rule.regex) {
    try {
      const re = new RegExp(rule.regex, 'i');
      if (!re.test(content)) return false;
    } catch (_err) {
      return false;
    }
  }

  if (rule.senders.length && !rule.senders.some((name) => sender.includes(name))) return false;
  if (rule.sessions.length && !sessionMatches(rule.sessions, input)) return false;

  return true;
}

/**
 * 综合判定
 * @param {object} input { content, sender, sessionName, groupName, sessionId, sessionType, mediaType, isSend, event }
 * @param {object} options { rules, config }
 */
function evaluate(input, options = {}) {
  const rules = Array.isArray(options.rules) ? options.rules : [];
  const config = options.config || {};
  const filters = config.filters || {};

  // 1. 系统事件
  if (input.event === 'message.revoke') {
    return { action: 'list', category: 'system', reason: '撤回事件', source: 'system' };
  }

  // 2. 自己发出的消息
  if (input.isSend) {
    return { action: 'ignore', category: 'chat', reason: '自己发送的消息', source: 'system' };
  }

  // 3. 静音会话
  if (sessionMatches(toStringList(filters.muteSessions), input)) {
    return { action: 'ignore', category: 'chat', reason: '会话已静音', source: 'filter' };
  }

  // 4. 用户规则（priority 小的优先，同优先级保持配置顺序）
  const enabledRules = rules
    .map(normalizeRule)
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.priority - b.priority);
  for (const rule of enabledRules) {
    if (ruleMatches(rule, input)) {
      return {
        action: rule.action,
        category: rule.category || 'custom',
        reason: `规则「${rule.name || '未命名'}」`,
        source: 'user',
        ruleId: rule.id,
        ruleName: rule.name
      };
    }
  }

  // 5. 重点会话
  if (sessionMatches(toStringList(filters.alwaysSessions), input)) {
    return { action: 'notify', category: 'notice', reason: '重点会话', source: 'filter' };
  }

  // 6. 内置识别
  const builtin = detectBuiltin(input);
  return {
    action: builtin.action,
    category: builtin.category,
    reason: builtin.reason,
    source: 'builtin',
    hits: builtin.hits,
    score: builtin.score
  };
}

/** 给 UI 的「快速模板」：用户一键加入示例规则 */
const RULE_TEMPLATES = [
  {
    name: '群公告与全员提醒',
    action: 'notify',
    category: 'notice',
    scope: 'group',
    anyKeywords: ['群公告', '@所有人', '重要通知'],
    priority: 10
  },
  {
    name: '验证码安全提醒',
    action: 'notify',
    category: 'security',
    scope: 'all',
    regex: '(验证码|校验码).{0,12}\\d{3,8}',
    priority: 5
  },
  {
    name: '快递取件通知',
    action: 'notify',
    category: 'logistics',
    scope: 'all',
    anyKeywords: ['取件码', '快递', '驿站', '丰巢'],
    priority: 20
  },
  {
    name: '老板/客户重点会话',
    action: 'notify',
    category: 'work',
    scope: 'all',
    sessions: ['老板', '客户'],
    priority: 30
  },
  {
    name: '忽略营销群广告',
    action: 'ignore',
    category: 'chat',
    scope: 'group',
    anyKeywords: ['优惠', '促销', '秒杀', '拼团'],
    priority: 200
  }
];

module.exports = {
  CATEGORIES,
  KEYWORD_GROUPS,
  ACTIONS,
  evaluate,
  detectBuiltin,
  normalizeRule,
  blankRule,
  ruleMatches,
  RULE_TEMPLATES,
  normalizeText
};
