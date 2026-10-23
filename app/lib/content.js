'use strict';

/**
 * 微信消息内容清洗。
 *
 * AstrWeChat / WeFlow 的原样 content 里，公众号文章、小程序、文件、撤回事件
 * 等大多是 XML（appmsg/sysmsg）。直接塞进通知列表会显示一大段 XML，
 * 也会让关键词分类永远命中不到标题。这里把 XML 还原成人类可读文本。
 */

const { normalizeText } = require('./rules');

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_m, n) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => safeChar(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeChar(code) {
  try {
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
  } catch (_err) {
    return '';
  }
}

function tagValue(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`, 'i');
  const match = re.exec(xml);
  if (!match) return '';
  return normalizeText(decodeEntities(match[1] != null ? match[1] : match[2]));
}

const REVOKE_RE = /revokemsg/i;
const APPMSG_RE = /<appmsg[\s>]/i;

/**
 * 把原始 content 变成可读文本。
 * @param {*} raw 原始 content
 * @returns {{text: string, kind: 'text'|'appmsg'|'revoke'|'xml', url?: string}}
 */
function humanizeContent(raw) {
  const original = raw == null ? '' : String(raw);
  const trimmed = original.trim();
  if (!trimmed) return { text: '', kind: 'text' };
  if (trimmed[0] !== '<') return { text: normalizeText(original), kind: 'text' };

  if (REVOKE_RE.test(trimmed)) {
    const replace = tagValue(trimmed, 'replacemsg');
    return { text: replace || '撤回了一条消息', kind: 'revoke' };
  }

  if (APPMSG_RE.test(trimmed)) {
    const title = tagValue(trimmed, 'title') || tagValue(trimmed, 'des');
    const url = tagValue(trimmed, 'url') || tagValue(trimmed, 'lowurl');
    if (title) return { text: title, kind: 'appmsg', url };
    return { text: url ? '链接消息' : '应用消息', kind: 'appmsg', url };
  }

  const title = tagValue(trimmed, 'title') || tagValue(trimmed, 'des');
  if (title) return { text: title, kind: 'xml' };

  const plain = normalizeText(decodeEntities(trimmed.replace(/<[^>]+>/g, ' ')));
  if (plain) return { text: plain, kind: 'xml' };
  return { text: '非文本消息', kind: 'xml' };
}

module.exports = { humanizeContent, decodeEntities, tagValue };
