'use strict';

/**
 * 日程时间识别 & 闹钟时间计算
 *
 * 目标：从中文聊天内容里尽量识别出「事情发生的时间」，用于给日程类消息自动设闹钟。
 * 识别是启发式的（聊天是口语），所以 UI 里必须允许手动改时间；识别结果只做默认值。
 */

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNumber(token) {
  if (!token) return null;
  if (/^\d+$/.test(token)) return Number(token);
  const str = String(token);
  if (str === '十') return 10;
  let total = 0;
  let current = 0;
  for (const ch of str) {
    if (ch === '十') {
      current = Math.max(current, 1) * 10;
      total += current;
      current = 0;
    } else if (CN_DIGITS[ch] != null) {
      current = CN_DIGITS[ch];
    } else {
      return null;
    }
  }
  return total + current;
}

// 把「三点」「十点半」这类中文数字统一成阿拉伯数字，便于后续正则；日期里的「五月」不动。
function normalizeChinese(text) {
  return String(text).replace(/(凌晨|早上|上午|中午|下午|傍晚|晚上|今晚|明晚|昨夜)?\s*([一二两三四五六七八九十]{1,3})\s*(?=[点时:：])/g, (m, period, num) => {
    const n = cnNumber(num);
    return n == null ? m : `${period || ''}${n}`;
  }).replace(/([一二两三四五六七八九十]{1,3})\s*点半/g, (m, num) => {
    const n = cnNumber(num);
    return n == null ? m : `${n}点半`;
  }).replace(/([一二两三四五六七八九十]{1,3})\s*分(钟)?/g, (m, num) => {
    const n = cnNumber(num);
    return n == null ? m : `${n}分`;
  });
}

const WEEKDAY_MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 七: 0 };

const PERIODS = [
  { re: /凌晨/, hour: 5, label: '凌晨' },
  { re: /(早上|早晨|清晨)/, hour: 8, label: '早上' },
  { re: /上午/, hour: 10, label: '上午' },
  { re: /中午/, hour: 12, label: '中午' },
  { re: /(下午|午后)/, hour: 15, label: '下午' },
  { re: /(傍晚)/, hour: 18, label: '傍晚' },
  { re: /(晚上|今晚)/, hour: 20, label: '晚上' }
];

function pickPeriod(text) {
  for (const p of PERIODS) {
    if (p.re.test(text)) return p;
  }
  return null;
}

function parseClock(text) {
  // 返回 {hour, minute} 或 null；支持 19:30 / 19点30分 / 19点半 / 7点
  const colon = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (colon) {
    const h = Number(colon[1]);
    const m = Number(colon[2]);
    if (h <= 24 && m <= 59) return { hour: h, minute: m };
  }
  const half = text.match(/(\d{1,2})\s*点半/);
  if (half) {
    const h = Number(half[1]);
    if (h <= 24) return { hour: h, minute: 30 };
  }
  const dot = text.match(/(\d{1,2})\s*[点时](?:\s*(\d{1,2})\s*分?)?/);
  if (dot) {
    const h = Number(dot[1]);
    const m = dot[2] != null ? Number(dot[2]) : 0;
    if (h <= 24 && m <= 59) return { hour: h, minute: m };
  }
  return null;
}

function parseWeeksOffset(prefix) {
  if (!prefix) return 0;
  if (/下+/.test(prefix)) return 1;
  if (/下下/.test(prefix)) return 2;
  return 0;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function atTime(date, hour, minute) {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 从文本解析日程时间。
 * @param {string} text 消息内容
 * @param {Date} now 参照时间
 * @returns {{ok:boolean, dueAt?:number, hasTime?:boolean, allDay?:boolean, matched?:string}}
 */
function parseSchedule(text, now = new Date()) {
  const raw = String(text || '');
  if (!raw.trim()) return { ok: false };
  const normalized = normalizeChinese(raw.replace(/\s+/g, ' '));
  const clock = parseClock(normalized);
  const period = pickPeriod(normalized);

  let baseDate = null; // 只到「日」精度
  let matchedParts = [];
  let allDay = false;
  let relHit = null;

  // 0) 相对天数：3天后 / 两天后
  if (!baseDate) {
    const rel = normalized.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*天\s*(?:后|之后|以后|后边?)/);
    if (rel) {
      const n = cnNumber(rel[1]);
      if (n != null && n >= 0 && n <= 60) {
        baseDate = addDays(startOfDay(now), n);
        relHit = rel[0];
        matchedParts.push(rel[0]);
      }
    }
  }

  // 1) 绝对日期：2026-11-01 / 2026年11月1日 / 11月1日 / 11月1号
  const abs = !baseDate && normalized.match(/(?:(\d{4})\s*[年\-\/]\s*)?(\d{1,2})\s*[月\-\/]\s*(\d{1,2})\s*[日号]?/);
  if (abs && Number(abs[2]) >= 1 && Number(abs[2]) <= 12 && Number(abs[3]) >= 1 && Number(abs[3]) <= 31) {
    const year = abs[1] ? Number(abs[1]) : null;
    const month = Number(abs[2]);
    const day = Number(abs[3]);
    const candidate = new Date(year || now.getFullYear(), month - 1, day, 0, 0, 0, 0);
    if (!year && candidate.getTime() < startOfDay(now).getTime() - 24 * 3600 * 1000) {
      // 没写年份且日期明显已过去 → 视为过期日程，不建闹钟
      return { ok: false, reason: 'past' };
    }
    baseDate = candidate;
    matchedParts.push(abs[0].trim());
  }

  // 2) 今天/明天/后天/大后天
  if (!baseDate) {
    const rel = normalized.match(/(今天|今日|明天|明日|后天|大后天|今早|今晚上?|明早|明晚)/);
    if (rel) {
      const word = rel[1];
      let offset = 0;
      if (/明/.test(word)) offset = 1;
      if (/后天/.test(word)) offset = 2;
      if (/大后天/.test(word)) offset = 3;
      baseDate = addDays(startOfDay(now), offset);
      relHit = word;
      matchedParts.push(word);
    }
  }

  // 3) 周几（周三 / 星期三 / 下周五）
  let weekdayHit = null;
  if (!baseDate) {
    const wk = normalized.match(/(下周|下下周|这周|本周|周|星期|礼拜)\s*([一二三四五六日天七])/);
    if (wk) {
      const target = WEEKDAY_MAP[wk[2]];
      const prefix = wk[1];
      let offset = parseWeeksOffset(prefix);
      const today = now.getDay();
      let diff = target - today;
      if (diff < 0) diff += 7;
      if (prefix && /下/.test(prefix)) {
        diff += 7 * Math.max(offset, 1);
      } else if (diff === 0 && clock) {
        // 今天就是周几，但时间已过 → 顺延一周
        const candidate = atTime(now, clock.hour, clock.minute);
        if (candidate.getTime() <= now.getTime()) diff = 7;
      }
      baseDate = addDays(startOfDay(now), diff);
      weekdayHit = wk[0];
      matchedParts.push(wk[0]);
    }
  }

  // 4) 只有时间（晚上7点半、15:00）
  if (!baseDate && clock) {
    baseDate = startOfDay(now);
    matchedParts.push(clock.hour + '点');
  }

  if (!baseDate) return { ok: false };

  if (!clock) {
    allDay = true;
    // 全天日程默认当天 09:00 提醒；已过则顺延
    let d = atTime(baseDate, 9, 0);
    if (d.getTime() <= now.getTime() + 60 * 1000) {
      d = weekdayHit ? atTime(addDays(baseDate, 7), 9, 0) : atTime(addDays(startOfDay(now), 1), 9, 0);
    }
    return { ok: true, dueAt: d.getTime(), hasTime: false, allDay: true, matched: matchedParts.join(' ') };
  }

  let { hour, minute } = clock;
  if (period) {
    if (period.label === '凌晨') {
      // 凌晨 1-5 点保持；凌晨 12 点 = 0 点
      if (hour === 12) hour = 0;
    } else if (hour < 12) {
      if (period.label === '中午') hour = hour === 12 ? 12 : hour + 12;
      else if (['下午', '傍晚', '晚上'].includes(period.label)) hour += 12;
    }
  }
  if (hour > 23) hour = hour % 24;
  if (hour === 24) hour = 0;

  let due = new Date(baseDate);
  due.setHours(hour, minute, 0, 0);
  if (due.getTime() <= now.getTime()) {
    // 没写日期/相对日期 && 时间已过 → 明天；写了具体日期但已过 → 作为过期日程返回失败，避免建出过去的闹钟
    if (abs || weekdayHit) return { ok: false, reason: 'past' };
    due = addDays(due, 1);
  }
  return { ok: true, dueAt: due.getTime(), hasTime: true, allDay: false, matched: matchedParts.join(' ') };
}

function formatReminderTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatCountdown(ms) {
  const diff = Math.max(0, ms);
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时 ${min % 60} 分`;
  const day = Math.floor(hour / 24);
  return `${day} 天 ${hour % 24} 小时`;
}

module.exports = { parseSchedule, formatReminderTime, formatCountdown, cnNumber, normalizeChinese };
