import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createServer, startServer } from '../src/serve.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('startServer binds a real port and serves /healthz', async () => {
  const server = startServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const res = await request(port, 'GET', '/healthz');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).status, 'ok');
  } finally {
    server.close();
  }
});

test('startServer applies default host/port when called with no args', async () => {
  // Covers the destructured defaults ({host,port} = {}). 8787 may be busy in
  // some environments; tolerate EADDRINUSE, we only need the default branch run.
  let server;
  try {
    server = startServer();
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    assert.equal(server.address().port, 8787);
    server.close();
  } catch (err) {
    assert.equal(err.code, 'EADDRINUSE');
  }
});

test('POST with PHI returns a block decision', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/', JSON.stringify({ prompt: 'patient SSN is 123-45-6789' }));
    assert.equal(res.status, 200);
    const out = JSON.parse(res.body);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /ssn_pattern/);
  } finally {
    server.close();
  }
});

test('POST with a clean prompt returns additionalContext', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/', JSON.stringify({ prompt: 'refactor the scheduler' }));
    assert.equal(res.status, 200);
    const out = JSON.parse(res.body);
    assert.equal(out.decision, undefined);
    assert.ok(out.hookSpecificOutput.additionalContext);
  } finally {
    server.close();
  }
});

test('GET /healthz returns ok', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await request(port, 'GET', '/healthz');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).status, 'ok');
  } finally {
    server.close();
  }
});

test('non-POST/non-health returns 405', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await request(port, 'GET', '/');
    assert.equal(res.status, 405);
  } finally {
    server.close();
  }
});

test('request aborted before body completes hits the error handler (no response sent)', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    // Promise the 'end' never fires: declare a large Content-Length, send only
    // part of the body, then abort. The request emits 'error'/'aborted' while
    // res.headersSent is still false, exercising the writeHead(400) path.
    await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        // Write a partial body under a larger Content-Length, then destroy the
        // socket in the same tick so the server sees a hard reset before the
        // body (and thus any response) completes — deterministic, no timer race.
        sock.write(
          'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\nContent-Type: application/json\r\n\r\n{"prompt":"partial',
        );
        sock.destroy();
      });
      sock.on('close', resolve);
      sock.on('error', () => {});
    });
    // Server is still healthy afterwards.
    const res = await request(port, 'GET', '/healthz');
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('server survives request error (mid-flight destroy)', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    // Trigger a request error by destroying the socket mid-flight
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, () => {
        // Do nothing with response
      });
      req.on('error', () => {
        // Expected error from destroying the socket
        resolve();
      });
      req.write(JSON.stringify({ prompt: 'test' }));
      req.destroy(); // Force the connection closed (triggers req error)
    });

    // Verify server is still alive with a clean POST request
    const res = await request(port, 'POST', '/', JSON.stringify({ prompt: 'refactor the scheduler' }));
    assert.equal(res.status, 200);
    const out = JSON.parse(res.body);
    assert.equal(out.decision, undefined);
    assert.ok(out.hookSpecificOutput.additionalContext);
  } finally {
    server.close();
  }
});
