// Download electron prebuilt zip from npmmirror
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
const version = process.argv[2] || '45.0.0';
const out = process.argv[3] || 'electron.zip';
const url = `https://npmmirror.com/mirrors/electron/${version}/electron-v${version}-win32-x64.zip`;
console.log('URL:', url);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) { console.error('HTTP', res.status, res.statusText); process.exit(1); }
const total = Number(res.headers.get('content-length') || 0);
console.log('size:', total, 'bytes');
const file = createWriteStream(out);
let got = 0, last = 0;
const reader = res.body.getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  got += value.length;
  if (!file.write(Buffer.from(value))) await new Promise(r => file.once('drain', r));
  if (got - last > 10 * 1024 * 1024) { last = got; console.log(`${(got/1048576).toFixed(1)} MiB / ${(total/1048576).toFixed(1)} MiB`); }
}
await new Promise(r => file.end(r));
console.log('DONE', got, 'bytes');
