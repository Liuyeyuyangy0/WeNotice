/**
 * WeNotice 本地联调用的 WeFlow API 模拟服务。
 * 用途：在没有安装 AstrWeChat 的情况下，验证「真实数据源」链路（HTTP + Token + SSE 主动推送）。
 *
 * 启动：node tools/mock-weflow.mjs [port] [token]
 * 默认：port=5031 token=test-token
 */

import http from 'node:http';

const PORT = Number(process.argv[2] || 5031);
const TOKEN = String(process.argv[3] || 'test-token');
const now = Math.floor(Date.now() / 1000);

const sessions = [
  { username: 'product-team@chatroom', displayName: '产品研发部', type: 'group', lastTimestamp: now, unreadCount: 2 },
  { username: '95588', displayName: '中国工商银行', type: 'official', lastTimestamp: now - 120, unreadCount: 1 },
  { username: 'sf-express', displayName: '顺丰速运', type: 'official', lastTimestamp: now - 300, unreadCount: 1 },
  { username: 'liqian', displayName: '李倩', type: 'private', lastTimestamp: now - 600, unreadCount: 1 },
  { username: 'design-group@chatroom', displayName: '设计交流群', type: 'group', lastTimestamp: now - 900, unreadCount: 3 }
];

const feed = [
  {
    event: 'message.new', sessionId: 'product-team@chatroom', sessionType: 'group', rawid: 'mock-1',
    sourceName: '陈立', groupName: '产品研发部',
    content: '【群公告】本周五下午 15:00 在 3 号会议室开季度评审会，请各位提前准备材料，收到请回复。',
    timestamp: now - 60, mediaType: 'text'
  },
  {
    event: 'message.new', sessionId: '95588', sessionType: 'official', rawid: 'mock-2',
    sourceName: '95588', groupName: '',
    content: '【工商银行】您正在登录网上银行，验证码 662901，5 分钟内有效，请勿转告他人。',
    timestamp: now - 95, mediaType: 'text'
  },
  {
    event: 'message.new', sessionId: 'sf-express', sessionType: 'official', rawid: 'mock-3',
    sourceName: '顺丰速运', groupName: '',
    content: '您的快递已到达阳光花园菜鸟驿站，取件码 7-3-1024，请于 24 小时内取件。',
    timestamp: now - 150, mediaType: 'text'
  },
  {
    event: 'message.new', sessionId: 'product-team@chatroom', sessionType: 'group', rawid: 'mock-4',
    sourceName: '行政部-周敏', groupName: '产品研发部',
    content: '@所有人 下周一停电检修，办公区全天断电，请提前保存文件并做好远程办公安排。',
    timestamp: now - 220, mediaType: 'text'
  },
  {
    event: 'message.new', sessionId: 'design-group@chatroom', sessionType: 'group', rawid: 'mock-5',
    sourceName: '小王', groupName: '设计交流群',
    content: '午饭吃什么？楼下新开了家麻辣烫，一起去吗',
    timestamp: now - 260, mediaType: 'text'
  },
  {
    event: 'message.new', sessionId: 'liqian', sessionType: 'private', rawid: 'mock-6',
    sourceName: '李倩', groupName: '',
    content: '你收到一笔转账 ¥2,000.00，请及时查收。',
    timestamp: now - 320, mediaType: 'text'
  },
  {
    event: 'message.new', sessionId: 'design-group@chatroom', sessionType: 'group', rawid: 'mock-7',
    sourceName: '阿哲', groupName: '设计交流群',
    content: '分享一篇好文：https://example.com/design-system-2026',
    timestamp: now - 380, mediaType: 'text'
  }
];

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const auth =
    (req.headers.authorization || '') === `Bearer ${TOKEN}` || url.searchParams.get('access_token') === TOKEN;

  if (url.pathname === '/health') {
    json(res, 200, { ok: true, data: { status: 'ok', version: 'mock' } });
    return;
  }

  if (!auth) {
    json(res, 401, { error: 'unauthorized', message: 'missing or invalid token' });
    return;
  }

  if (url.pathname === '/api/v1/sessions') {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 50));
    json(res, 200, { sessions: sessions.slice(0, limit) });
    return;
  }

  const sessionMsgs = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/);
  if (sessionMsgs) {
    const id = decodeURIComponent(sessionMsgs[1]);
    const list = feed
      .filter((m) => m.sessionId === id)
      .map((m, index) => ({
        localId: index + 1,
        serverId: `srv-${m.rawid}`,
        localType: 1,
        createTime: m.timestamp,
        isSend: false,
        senderUsername: m.sourceName,
        content: m.content,
        parsedContent: m.content,
        mediaType: m.mediaType
      }));
    json(res, 200, { messages: list });
    return;
  }

  if (url.pathname === '/api/v1/push/messages') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(': mock stream connected\n\n');

    let index = 0;
    const timer = setInterval(() => {
      if (index >= feed.length) {
        clearInterval(timer);
        return;
      }
      const item = Object.assign({}, feed[index], { timestamp: Math.floor(Date.now() / 1000) - 10 * index });
      index += 1;
      res.write(`event: ${item.event}\ndata: ${JSON.stringify(item)}\n\n`);
    }, 900);

    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);

    req.on('close', () => {
      clearInterval(timer);
      clearInterval(heartbeat);
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-weflow] listening on http://127.0.0.1:${PORT} token=${TOKEN}`);
});
