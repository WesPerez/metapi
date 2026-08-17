import { readFileSync } from 'node:fs';
import { Agent, Headers, type Dispatcher } from 'undici';
import { config } from '../config.js';

const RESIN_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

let cachedTokenPath = '';
let cachedToken = '';
const gatewayAgentCache = new Map<string, Agent>();

function gatewayToken(): string {
  const path = config.resinEgressGatewayTokenFile;
  if (!path) return '';
  if (cachedTokenPath === path && cachedToken) return cachedToken;
  try {
    cachedToken = readFileSync(path, 'utf8').trim();
    cachedTokenPath = path;
    return cachedToken;
  } catch {
    return '';
  }
}

function endpointOf(parsed: URL): string {
  return `${parsed.hostname.toLowerCase()}:${parsed.port || '1080'}`;
}

function configuredResinEndpoints(): Set<string> {
  return new Set(
    config.resinStickyProxyEndpoints
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isConfiguredResinProxy(proxyUrl: string): boolean {
  try {
    const parsed = new URL(proxyUrl);
    return RESIN_PROXY_PROTOCOLS.has(parsed.protocol.toLowerCase())
      && configuredResinEndpoints().has(endpointOf(parsed));
  } catch {
    return false;
  }
}

function routeKeyFromProxy(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    const username = decodeURIComponent(parsed.username || '');
    if (username) return username;
    return `resin-${endpointOf(parsed)}`;
  } catch {
    return 'resin-shared';
  }
}

function targetUrlFromOptions(options: Dispatcher.DispatchOptions): string {
  const target = new URL(options.path, String(options.origin || ''));
  if (options.query && typeof options.query === 'object') {
    for (const [key, value] of Object.entries(options.query)) {
      if (Array.isArray(value)) {
        for (const item of value) target.searchParams.append(key, String(item));
      } else if (value !== undefined && value !== null) {
        target.searchParams.set(key, String(value));
      }
    }
  }
  return target.toString();
}

function copyRequestHeaders(input: Dispatcher.DispatchOptions['headers']): string[] {
  const headers = new Headers();
  if (Array.isArray(input)) {
    for (let index = 0; index + 1 < input.length; index += 2) {
      const name = input[index];
      const value = input[index + 1];
      if (typeof name === 'string' && typeof value === 'string') headers.append(name, value);
    }
  } else if (input && typeof (input as Iterable<unknown>)[Symbol.iterator] === 'function') {
    for (const pair of input as Iterable<[string, string | string[] | undefined]>) {
      const [name, value] = pair;
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    }
  } else if (input && typeof input === 'object') {
    for (const [name, value] of Object.entries(input as Record<string, string | string[] | undefined>)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    }
  }

  const connectionTokens = new Set(
    (headers.get('connection') || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  const output: string[] = [];
  headers.forEach((value, name) => {
    if (
      name === 'host'
      || name === 'proxy-authorization'
      || name.startsWith('x-egress-')
      || HOP_BY_HOP_HEADERS.has(name)
      || connectionTokens.has(name)
    ) return;
    output.push(name, value);
  });
  return output;
}

function gatewayPath(gatewayUrl: URL): string {
  const base = gatewayUrl.pathname.replace(/\/+$/, '');
  return `${base}/v1/forward`;
}

function gatewayAgent(gatewayUrl: URL): Agent {
  const key = gatewayUrl.origin;
  const cached = gatewayAgentCache.get(key);
  if (cached) return cached;
  const agent = new Agent({
    connectTimeout: 5_000,
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  gatewayAgentCache.set(key, agent);
  return agent;
}

function gatewayRetryMode(method: Dispatcher.HttpMethod | undefined, headers: string[]): 'safe' | 'transport' {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const methodIsSafe = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(normalizedMethod);
  const hasIdempotencyKey = headers.some((name, index) => (
    index % 2 === 0 && name.toLowerCase() === 'idempotency-key'
  ));
  return methodIsSafe || hasIdempotencyKey ? 'safe' : 'transport';
}

export function createResinEgressGatewayDispatcher(proxyUrl: string): Dispatcher | undefined {
  if (!config.resinEgressGatewayUrl || !isConfiguredResinProxy(proxyUrl)) return undefined;
  const token = gatewayToken();
  if (!token) return undefined;

  let gatewayUrl: URL;
  try {
    gatewayUrl = new URL(config.resinEgressGatewayUrl);
    if (gatewayUrl.protocol !== 'http:' && gatewayUrl.protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }

  const routeKey = routeKeyFromProxy(proxyUrl);
  const agent = gatewayAgent(gatewayUrl);
  return agent.compose((dispatch) => (options, handler) => {
    let target: string;
    try {
      target = targetUrlFromOptions(options);
    } catch (error) {
      queueMicrotask(() => handler.onError?.(error instanceof Error ? error : new Error(String(error))));
      return false;
    }

    const headers = copyRequestHeaders(options.headers);
    headers.push('proxy-authorization', `Bearer ${token}`);
    headers.push('x-egress-target', Buffer.from(target).toString('base64url'));
    headers.push('x-egress-key', routeKey);
    headers.push('x-egress-retry-mode', gatewayRetryMode(options.method, headers));
    headers.push('x-egress-response-header-timeout-ms', String(config.resinEgressResponseHeaderTimeoutMs));
    headers.push('x-egress-first-byte-timeout-ms', String(config.resinEgressResponseHeaderTimeoutMs));

    return dispatch({
      ...options,
      origin: gatewayUrl.origin,
      path: gatewayPath(gatewayUrl),
      query: undefined,
      headers,
    }, handler);
  });
}
