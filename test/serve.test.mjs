import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/serve.mjs';

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
