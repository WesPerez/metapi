import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveSiteProxyUrlByRequestUrl } from '../siteProxy.js';
import { solveNewApiAcwScV2 } from './newApiShield.js';

const execFileAsync = promisify(execFile);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

type CurlProxyConfig = {
  url: string;
  username?: string;
  password?: string;
};

type AnyRouterHelperConfig = {
  url: string;
  token: string;
};

export type AnyRouterCurlRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  cookieHeader?: string;
  body?: string;
  timeoutMs?: number;
};

function curlConfigValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function resolveCurlProxy(requestUrl: string): Promise<CurlProxyConfig | null> {
  const envFile = String(process.env.ANYROUTER_CURL_PROXY_ENV_FILE || '').trim();
  if (envFile) {
    const values = parseEnvFile(await readFile(envFile, 'utf8'));
    const host = String(values.CN_SOCKS_HOST || '').trim();
    const port = Number.parseInt(String(values.CN_SOCKS_PORT || ''), 10);
    const username = String(values.CN_SOCKS_USER || '');
    const password = String(values.CN_SOCKS_PASS || '');
    if (!/^[A-Za-z0-9.-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('AnyRouter curl SOCKS endpoint is invalid');
    }
    if (!username || !password || /[\r\n]/.test(username + password)) {
      throw new Error('AnyRouter curl SOCKS credentials are invalid');
    }
    return {
      url: `socks5h://${host}:${port}`,
      username,
      password,
    };
  }

  const proxyUrl = await resolveSiteProxyUrlByRequestUrl(requestUrl);
  return proxyUrl ? { url: proxyUrl } : null;
}

async function resolveHelperConfig(): Promise<AnyRouterHelperConfig | null> {
  const envFile = String(process.env.ANYROUTER_HELPER_ENV_FILE || '').trim();
  if (!envFile) return null;
  const values = parseEnvFile(await readFile(envFile, 'utf8'));
  const rawUrl = String(values.ANYROUTER_HELPER_URL || '').trim();
  const token = String(values.ANYROUTER_HELPER_TOKEN || '');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error('AnyRouter helper URL is invalid');
  }
  if (parsedUrl.protocol !== 'http:' || !parsedUrl.hostname || /[\r\n]/.test(token) || token.length < 16) {
    throw new Error('AnyRouter helper configuration is invalid');
  }
  return {
    url: new URL('/request', parsedUrl).toString(),
    token,
  };
}

function getHeaderValue(headers: Record<string, string> | undefined, name: string): string {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) return String(value);
  }
  return '';
}

function resolveHelperOperation(requestUrl: URL): string {
  const path = requestUrl.pathname;
  if (path === '/api/user/self') return 'self';
  if (path === '/api/user/sign_in') return 'sign_in';
  if (path === '/api/user/checkin') return 'checkin';
  if (path === '/api/token/' || path === '/api/token') return 'tokens';
  if (path === '/api/user/models') return 'models_session';
  if (path === '/v1/models') return 'models_api';
  throw new Error('AnyRouter helper operation is not allowed');
}

async function fetchViaHelper<T>(
  helper: AnyRouterHelperConfig,
  requestUrl: URL,
  options: AnyRouterCurlRequestOptions,
  timeoutMs: number,
): Promise<T> {
  const { fetch } = await import('undici');
  const userIdRaw = getHeaderValue(options.headers, 'New-Api-User');
  const userId = Number.parseInt(userIdRaw, 10);
  const authorization = getHeaderValue(options.headers, 'Authorization');
  const response = await fetch(helper.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Metapi-Helper-Token': helper.token,
    },
    body: JSON.stringify({
      operation: resolveHelperOperation(requestUrl),
      cookieHeader: options.cookieHeader || undefined,
      userId: Number.isInteger(userId) && userId > 0 ? userId : undefined,
      authorization: authorization || undefined,
      body: options.body,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const payload = parseJson<T>(text);
  if (!response.ok || !payload) {
    throw new Error(`AnyRouter helper request failed with HTTP ${response.status}`);
  }
  return payload;
}

function stripBearerPrefix(token: string): string {
  const trimmed = String(token || '').trim();
  return trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
}

export function isAnyRouterSessionCredential(token: string): boolean {
  const raw = stripBearerPrefix(token);
  if (!raw || /[\r\n]/.test(raw) || raw.startsWith('sk-')) return false;
  if (/^(?:session|token|auth_token|access_token|jwt|jwt_token)=/i.test(raw)) return true;
  return raw.length >= 128 && /^[A-Za-z0-9_+=;\-\s]+$/.test(raw);
}

export function buildAnyRouterSessionCookieHeader(token: string): string {
  const raw = stripBearerPrefix(token);
  if (!raw || /[\r\n]/.test(raw)) return '';
  if (/^(?:session|token|auth_token|access_token|jwt|jwt_token)=/i.test(raw)) return raw;
  return `session=${raw}`;
}

function parseCookiePairs(cookieHeader: string): Array<{ name: string; value: string }> {
  const pairs: Array<{ name: string; value: string }> = [];
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || /[\r\n\t]/.test(value)) continue;
    pairs.push({ name, value });
  }
  return pairs;
}

function buildCookieJar(
  hostname: string,
  secure: boolean,
  cookieHeader: string,
): string {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const pair of parseCookiePairs(cookieHeader)) {
    lines.push([
      hostname,
      'FALSE',
      '/',
      secure ? 'TRUE' : 'FALSE',
      '0',
      pair.name,
      pair.value,
    ].join('\t'));
  }
  lines.push('');
  return lines.join('\n');
}

async function upsertCookieJar(
  path: string,
  hostname: string,
  secure: boolean,
  name: string,
  value: string,
): Promise<void> {
  let lines: string[] = [];
  try {
    lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  } catch {}
  const next = lines.filter((line) => {
    if (!line || line.startsWith('#')) return true;
    const fields = line.split('\t');
    return fields.length < 7 || fields[5] !== name;
  });
  next.push([
    hostname,
    'FALSE',
    '/',
    secure ? 'TRUE' : 'FALSE',
    '0',
    name,
    value,
  ].join('\t'));
  next.push('');
  await writeFile(path, next.join('\n'), { mode: 0o600 });
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isShieldChallenge(content: string): boolean {
  return /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|denied by http_custom/i.test(content);
}

export async function fetchAnyRouterJsonWithCurl<T>(
  requestUrl: string,
  options: AnyRouterCurlRequestOptions = {},
): Promise<T> {
  const parsedUrl = new URL(requestUrl);
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error('AnyRouter curl request URL is invalid');
  }

  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 20_000, 120_000));
  const helper = await resolveHelperConfig();
  if (helper) {
    return fetchViaHelper<T>(helper, parsedUrl, options, timeoutMs);
  }
  const proxy = await resolveCurlProxy(requestUrl);
  const workDir = await mkdtemp(join(tmpdir(), 'metapi-anyrouter-curl.'));
  const configPath = join(workDir, 'curl.conf');
  const cookieJarPath = join(workDir, 'cookies.txt');
  const requestBodyPath = join(workDir, 'request-body');
  const responseBodyPath = join(workDir, 'response-body');

  try {
    await writeFile(
      cookieJarPath,
      buildCookieJar(parsedUrl.hostname, parsedUrl.protocol === 'https:', options.cookieHeader || ''),
      { mode: 0o600 },
    );
    if (options.body !== undefined) {
      await writeFile(requestBodyPath, options.body, { mode: 0o600 });
    }

    const configLines = [
      'silent',
      'show-error',
      'compressed',
      'max-redirs = 0',
      `connect-timeout = ${Math.max(1, Math.ceil(Math.min(timeoutMs, 10_000) / 1_000))}`,
      `max-time = ${Math.max(1, Math.ceil(timeoutMs / 1_000))}`,
      `request = "${curlConfigValue((options.method || 'GET').toUpperCase())}"`,
      `user-agent = "${curlConfigValue(USER_AGENT)}"`,
      'header = "Accept: application/json"',
      `cookie = "${curlConfigValue(cookieJarPath)}"`,
      `cookie-jar = "${curlConfigValue(cookieJarPath)}"`,
      `output = "${curlConfigValue(responseBodyPath)}"`,
      'write-out = "%{http_code}"',
      `url = "${curlConfigValue(requestUrl)}"`,
    ];

    let hasContentType = false;
    for (const [name, value] of Object.entries(options.headers || {})) {
      if (!name || /[\r\n]/.test(name + value)) continue;
      if (name.toLowerCase() === 'cookie' || name.toLowerCase() === 'user-agent') continue;
      if (name.toLowerCase() === 'content-type') hasContentType = true;
      configLines.push(`header = "${curlConfigValue(`${name}: ${value}`)}"`);
    }
    if (options.body !== undefined) {
      if (!hasContentType) configLines.push('header = "Content-Type: application/json"');
      configLines.push(`data-binary = "@${curlConfigValue(requestBodyPath)}"`);
    }
    if (proxy) {
      configLines.push(`proxy = "${curlConfigValue(proxy.url)}"`);
      if (proxy.username || proxy.password) {
        configLines.push(
          `proxy-user = "${curlConfigValue(`${proxy.username || ''}:${proxy.password || ''}`)}"`,
        );
      }
    }
    await writeFile(configPath, `${configLines.join('\n')}\n`, { mode: 0o600 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { stdout } = await execFileAsync('curl', ['--config', configPath], {
        encoding: 'utf8',
        maxBuffer: MAX_RESPONSE_BYTES,
        timeout: timeoutMs + 2_000,
      });
      const statusCode = Number.parseInt(stdout.trim(), 10);
      const responseBody = await readFile(responseBodyPath, 'utf8');
      const payload = parseJson<T>(responseBody);
      if (payload) return payload;

      const acwScV2 = isShieldChallenge(responseBody)
        ? solveNewApiAcwScV2(responseBody)
        : null;
      if (!acwScV2) {
        throw new Error(`AnyRouter curl returned non-JSON HTTP ${statusCode || 0}`);
      }
      await upsertCookieJar(
        cookieJarPath,
        parsedUrl.hostname,
        parsedUrl.protocol === 'https:',
        'acw_sc__v2',
        acwScV2,
      );
    }

    throw new Error('AnyRouter curl challenge retry limit exceeded');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
