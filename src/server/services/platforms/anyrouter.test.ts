import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnyRouterAdapter } from './anyrouter.js';

describe('AnyRouterAdapter check-in', () => {
  let server: Server | undefined;
  let workDir = '';
  const previousEnvFile = process.env.ANYROUTER_HELPER_ENV_FILE;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error?: Error) => (error ? reject(error) : resolve()));
      });
    }
    if (workDir) await rm(workDir, { recursive: true, force: true });
    if (previousEnvFile === undefined) delete process.env.ANYROUTER_HELPER_ENV_FILE;
    else process.env.ANYROUTER_HELPER_ENV_FILE = previousEnvFile;
    server = undefined;
    workDir = '';
  });

  it('uses the self endpoint to expose an expired session after empty check-in failures', async () => {
    const helperToken = 'test-helper-token-with-enough-length';
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { operation?: string };
        const payload = body.operation === 'self'
          ? { success: false, message: 'Unauthorized, invalid access token' }
          : { success: false };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    workDir = await mkdtemp(join(tmpdir(), 'metapi-anyrouter-adapter-test.'));
    const envPath = join(workDir, 'helper.env');
    await writeFile(
      envPath,
      `ANYROUTER_HELPER_URL=http://127.0.0.1:${address.port}\nANYROUTER_HELPER_TOKEN=${helperToken}\n`,
      { mode: 0o600 },
    );
    process.env.ANYROUTER_HELPER_ENV_FILE = envPath;

    const result = await new AnyRouterAdapter().checkin(
      'https://anyrouter.top',
      `session=${'A'.repeat(160)}`,
      199848,
    );

    expect(result).toEqual({
      success: false,
      message: 'Unauthorized, invalid access token',
      reward: undefined,
    });
  });
});
