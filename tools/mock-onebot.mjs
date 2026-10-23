// 极简 OneBot 11 WebSocket 服务端 mock，用于联调 WeNotice 的 QQ 数据源。
// 无第三方依赖：手动完成 WebSocket 握手，然后按间隔推送 lifecycle + message 事件。
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] || 3001);
const TOKEN = process.argv[3] || '';

function frame(payload) {
  const data = Buffer.from(payload, 'utf8');
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

const clients = new Set();

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, service: 'mock-onebot', port: PORT }));
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (TOKEN && url.searchParams.get('access_token') !== TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  clients.add(socket);
  console.log(`[mock-onebot] client connected (${clients.size})`);

  let alive = true;
  const send = (obj) => {
    if (!alive) return;
    try {
      socket.write(frame(JSON.stringify(obj)));
    } catch (_err) {
      /* ignore */
    }
  };

  // 握手事件：OneBot 11 客户端通常据此确认连接成功
  send({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: 10001, time: Math.floor(Date.now() / 1000) });

  const samples = [
    {
      message_type: 'group',
      group_id: 987654321,
      sender: { user_id: 10002, nickname: '测试群友', card: '测试群友' },
      raw_message: '【群公告】测试群公告：本周五 15:00 在 3 号会议室开季度评审会，请各位提前准备材料。',
      message: [{ type: 'text', data: { text: '【群公告】测试群公告：本周五 15:00 在 3 号会议室开季度评审会，请各位提前准备材料。' } }]
    },
    {
      message_type: 'private',
      sender: { user_id: 10003, nickname: '测试好友' },
      raw_message: '验证码 882901，5 分钟内有效，请勿转告他人。',
      message: [{ type: 'text', data: { text: '验证码 882901，5 分钟内有效，请勿转告他人。' } }]
    },
    {
      message_type: 'group',
      group_id: 987654321,
      sender: { user_id: 10002, nickname: '测试群友', card: '测试群友' },
      raw_message: '顺丰快递已到阳光花园菜鸟驿站，取件码 7-3-1024，请于 24 小时内取件。',
      message: [{ type: 'text', data: { text: '顺丰快递已到阳光花园菜鸟驿站，取件码 7-3-1024，请于 24 小时内取件。' } }]
    },
    {
      message_type: 'group',
      group_id: 555000111,
      sender: { user_id: 10004, nickname: '阿哲' },
      raw_message: '[图片]',
      message: [{ type: 'image', data: { url: 'https://example.com/demo.png', file: 'demo.png', summary: '[图片]' } }]
    },
    {
      message_type: 'private',
      sender: { user_id: 10003, nickname: '测试好友' },
      raw_message: '晚上吃什么？',
      message: [{ type: 'text', data: { text: '晚上吃什么？' } }]
    }
  ];

  let index = 0;
  const timer = setInterval(() => {
    const sample = samples[index % samples.length];
    index += 1;
    send({
      post_type: 'message',
      time: Math.floor(Date.now() / 1000),
      self_id: 10001,
      message_id: 9000 + index,
      ...sample
    });
    console.log(`[mock-onebot] pushed message #${index}`);
  }, 2000);

  socket.on('close', () => {
    alive = false;
    clearInterval(timer);
    clients.delete(socket);
    console.log(`[mock-onebot] client disconnected (${clients.size})`);
  });
  socket.on('error', () => {
    alive = false;
    clearInterval(timer);
    clients.delete(socket);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-onebot] listening on ws://127.0.0.1:${PORT}${TOKEN ? ` (token=${TOKEN})` : ''}`);
});
