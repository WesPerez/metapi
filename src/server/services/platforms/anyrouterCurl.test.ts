import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAnyRouterSessionCookieHeader,
  fetchAnyRouterJsonWithCurl,
  isAnyRouterSessionCredential,
} from './anyrouterCurl.js';

const challengeHtml = readFileSync(
  new URL('./__fixtures__/anyrouter-challenge.html', import.meta.url),
  'utf8',
);

describe('AnyRouter curl transport', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((request, response) => {
      const cookie = String(request.headers.cookie || '');
      if (!cookie.includes('acw_sc__v2=')) {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': ['acw_tc=test; Path=/', 'cdn_sec_tc=test; Path=/'],
        });
        response.end(challengeHtml);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: { id: 123 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => (error ? reject(error) : resolve()));
    });
  });

  it('normalizes raw and prefixed session values', () => {
    const raw = `${'A'.repeat(160)}=`;
    expect(isAnyRouterSessionCredential(raw)).toBe(true);
    expect(buildAnyRouterSessionCookieHeader(raw)).toBe(`session=${raw}`);
    expect(buildAnyRouterSessionCookieHeader(`session=${raw}`)).toBe(`session=${raw}`);
    expect(isAnyRouterSessionCredential('sk-test-key')).toBe(false);
  });

  it('solves the ACW challenge with curl cookie-jar retries', async () => {
    const payload = await fetchAnyRouterJsonWithCurl<any>(`${baseUrl}/api/user/self`, {
      cookieHeader: 'session=test-session',
    });
    expect(payload).toMatchObject({ success: true, data: { id: 123 } });
  });

  it('uses the configured host helper for production AnyRouter operations', async () => {
    const helperToken = 'test-helper-token-with-enough-length';
    const workDir = await mkdtemp(join(tmpdir(), 'metapi-anyrouter-helper-test.'));
    const envPath = join(workDir, 'helper.env');
    let receivedBody: Record<string, unknown> | null = null;
    let receivedToken = '';

    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => (error ? reject(error) : resolve()));
    });
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        receivedToken = String(request.headers['x-metapi-helper-token'] || '');
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true, data: { id: 213232 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    await writeFile(
      envPath,
      `ANYROUTER_HELPER_URL=${baseUrl}\nANYROUTER_HELPER_TOKEN=${helperToken}\n`,
      { mode: 0o600 },
    );

    const previousEnvFile = process.env.ANYROUTER_HELPER_ENV_FILE;
    process.env.ANYROUTER_HELPER_ENV_FILE = envPath;
    try {
      const payload = await fetchAnyRouterJsonWithCurl<any>('https://anyrouter.top/api/user/self', {
        cookieHeader: 'session=fake-session-cookie',
        headers: { 'New-Api-User': '213232' },
      });

      expect(payload).toMatchObject({ success: true, data: { id: 213232 } });
      expect(receivedToken).toBe(helperToken);
      expect(receivedBody).toEqual({
        operation: 'self',
        cookieHeader: 'session=fake-session-cookie',
        userId: 213232,
      });
    } finally {
      if (previousEnvFile === undefined) delete process.env.ANYROUTER_HELPER_ENV_FILE;
      else process.env.ANYROUTER_HELPER_ENV_FILE = previousEnvFile;
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
