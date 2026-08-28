import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const port = Number(process.env.PORT ?? 8099);
const file = process.env.NOTIFICATION_LOG ?? '/data/notifications.jsonl';
mkdirSync('/data', { recursive: true });
try {
  readFileSync(file);
} catch {
  writeFileSync(file, '');
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/notifications') {
    const body = readFileSync(file, 'utf8');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      items: body.trim() ? body.trim().split('\n').map((line) => JSON.parse(line)) : [],
    }));
    return;
  }
  if (req.method === 'POST' && req.url === '/notify') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let payload = {};
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { raw };
      }
      const record = {
        receivedAt: new Date().toISOString(),
        idempotencyKey: req.headers['idempotency-key'] ?? null,
        notificationId: payload.notificationId ?? null,
        type: payload.type ?? null,
      };
      appendFileSync(file, `${JSON.stringify(record)}\n`);
      res.writeHead(204);
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[notification-sink] listening on :${port}`);
});
