import { createServer } from 'node:http';

let healthy = true;
const port = Number(process.env.PORT ?? 8088);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'fail', service: 'pi-ops-drill' }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/fail') {
    healthy = false;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ healthy }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/ok') {
    healthy = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ healthy }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[pi-ops-drill] listening on :${port}`);
});
