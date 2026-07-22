import http from 'node:http';
import { processHookInput } from '../hooks/pre-prompt-guard.mjs';

export function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const { stdout } = processHookInput(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(stdout);
    });
    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(400);
        res.end();
      }
    });
  });
}

export function startServer({ host = '127.0.0.1', port = 8787 } = {}) {
  const server = createServer();
  server.listen(port, host);
  return server;
}
