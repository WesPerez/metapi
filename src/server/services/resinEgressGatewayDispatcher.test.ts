import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch, type Dispatcher } from 'undici';

type CapturedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

type ResponsePlan = {
  status: number;
  body: string;
  contentType?: string;
};

const RESIN_PROXY = 'socks5h://AppsGlobal.metapi-account-40:secret@proxy.internal:10834';

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('resinEgressGatewayDispatcher', () => {
  let server: Server;
  let gatewayUrl = '';
  let tempDir = '';
  let tokenPath = '';
  let captured: CapturedRequest[] = [];
  let responsePlan: ResponsePlan = { status: 200, body: '{"ok":true}' };
  let activeDispatcher: Dispatcher | undefined;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'metapi-resin-gateway-dispatcher-'));
    tokenPath = join(tempDir, 'gateway.token');
    writeFileSync(tokenPath, 'gateway-test-token-123', { mode: 0o600 });

    server = createServer((request, response) => {
      void readBody(request).then((body) => {
        captured.push({
          method: request.method || '',
          url: request.url || '',
          headers: Object.fromEntries(
            Object.entries(request.headers).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join(', ') : String(value ?? ''),
            ]),
          ),
          body,
        });
        response.writeHead(responsePlan.status, {
          'content-type': responsePlan.contentType || 'application/json',
        });
        response.end(responsePlan.body);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    gatewayUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    captured = [];
    responsePlan = { status: 200, body: '{"ok":true}' };
    activeDispatcher = undefined;
    vi.stubEnv('RESIN_EGRESS_GATEWAY_URL', gatewayUrl);
    vi.stubEnv('RESIN_EGRESS_GATEWAY_TOKEN_FILE', tokenPath);
    vi.stubEnv('RESIN_STICKY_PROXY_ENDPOINTS', 'proxy.internal:10834');
    vi.stubEnv('RESIN_EGRESS_RESPONSE_HEADER_TIMEOUT_MS', '7000');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await activeDispatcher?.destroy().catch(() => {});
    activeDispatcher = undefined;
  });

  async function loadCreateDispatcher() {
    vi.resetModules();
    const module = await import('./resinEgressGatewayDispatcher.js');
    return module.createResinEgressGatewayDispatcher;
  }

  it('forwards method, body, auth/cookie/business headers and gateway metadata', async () => {
    const create = await loadCreateDispatcher();
    const dispatcher = create(RESIN_PROXY);
    expect(dispatcher).toBeDefined();
    activeDispatcher = dispatcher;

    const target = 'https://api.example.com/v1/chat/completions?x=1';
    const body = JSON.stringify({ model: 'gpt-5.6', stream: false });
    const response = await fetch(target, {
      dispatcher,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer upstream-token',
        cookie: 'session=abc',
        'x-requested-with': 'XMLHttpRequest',
        'new-api-user': '42',
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(captured).toHaveLength(1);

    const forwarded = captured[0]!;
    expect(forwarded.method).toBe('POST');
    expect(forwarded.url).toBe('/v1/forward');
    expect(forwarded.headers.authorization).toBe('Bearer upstream-token');
    expect(forwarded.headers.cookie).toBe('session=abc');
    expect(forwarded.headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(forwarded.headers['new-api-user']).toBe('42');
    expect(forwarded.headers['proxy-authorization']).toBe('Bearer gateway-test-token-123');
    expect(forwarded.headers['x-egress-key']).toBe('AppsGlobal.metapi-account-40');
    expect(forwarded.headers['x-egress-retry-mode']).toBe('transport');
    expect(forwarded.headers['x-egress-response-header-timeout-ms']).toBe('7000');
    expect(forwarded.headers['x-egress-first-byte-timeout-ms']).toBe('7000');

    const decodedTarget = Buffer.from(forwarded.headers['x-egress-target']!, 'base64url').toString('utf8');
    expect(decodedTarget).toBe(target);
    expect(JSON.parse(forwarded.body)).toEqual(JSON.parse(body));
  });

  it('sends a 503 to the gateway exactly once without a wrapping RetryAgent', async () => {
    const create = await loadCreateDispatcher();
    const dispatcher = create(RESIN_PROXY);
    expect(dispatcher).toBeDefined();
    activeDispatcher = dispatcher;

    responsePlan = { status: 503, body: '{"error":"unavailable"}' };
    const response = await fetch('https://api.example.com/v1/chat/completions', {
      dispatcher,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer upstream-token',
      },
      body: '{"stream":false}',
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"unavailable"}');
    expect(captured).toHaveLength(1);
  });

  it('marks idempotent requests safe for bounded status retries inside the gateway', async () => {
    const create = await loadCreateDispatcher();
    const dispatcher = create(RESIN_PROXY);
    expect(dispatcher).toBeDefined();
    activeDispatcher = dispatcher;

    const response = await fetch('https://api.example.com/api/user/self', {
      dispatcher,
      method: 'GET',
      headers: { cookie: 'session=abc' },
    });

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers['x-egress-retry-mode']).toBe('safe');
  });

  it('returns undefined when the gateway is not configured', async () => {
    vi.stubEnv('RESIN_EGRESS_GATEWAY_URL', '');
    const create = await loadCreateDispatcher();
    expect(create(RESIN_PROXY)).toBeUndefined();
  });

  it('returns undefined when the token file is not configured', async () => {
    vi.stubEnv('RESIN_EGRESS_GATEWAY_TOKEN_FILE', '');
    const create = await loadCreateDispatcher();
    expect(create(RESIN_PROXY)).toBeUndefined();
  });

  it('returns undefined for a proxy outside the configured Resin endpoints', async () => {
    const create = await loadCreateDispatcher();
    expect(
      create('socks5h://AppsGlobal.metapi-account-40:secret@other.internal:10834'),
    ).toBeUndefined();
  });
});
