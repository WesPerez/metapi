import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Dispatcher } from 'undici';
import { config } from '../config.js';

const BODY_PREFIX_LIMIT = 32 * 1024;
const RESIN_PROXY_PROTOCOLS = new Set(['socks:', 'socks5:', 'socks5h:']);
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export type ResinProxyIdentity = {
  proxyHost: string;
  proxyPort: number;
  platform: string;
  account: string;
};

type FeedbackKind =
  | 'cloudflare_challenge'
  | 'gateway_502'
  | 'gateway_504'
  | 'transport_connect'
  | 'transport_tls'
  | 'transport_timeout'
  | 'transport_reset';

let cachedTokenPath = '';
let cachedToken = '';

function endpointSet(): Set<string> {
  return new Set(
    config.resinStickyProxyEndpoints
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function endpointOf(url: URL): string {
  const port = url.port || '1080';
  return `${url.hostname.toLowerCase()}:${port}`;
}

export function parseResinProxyIdentity(
  proxyUrl: string,
  endpoints: ReadonlySet<string> = endpointSet(),
): ResinProxyIdentity | null {
  if (endpoints.size === 0) return null;
  try {
    const parsed = new URL(proxyUrl);
    if (!RESIN_PROXY_PROTOCOLS.has(parsed.protocol.toLowerCase())) return null;
    if (!endpoints.has(endpointOf(parsed))) return null;
    const username = decodeURIComponent(parsed.username || '');
    const separatorIndex = username.indexOf('.');
    if (separatorIndex < 1 || separatorIndex === username.length - 1) return null;
    return {
      proxyHost: parsed.hostname,
      proxyPort: Number.parseInt(parsed.port, 10) || 1080,
      platform: username.slice(0, separatorIndex),
      account: username.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

export function classifyResinResponseFailure(
  statusCode: number,
  bodyPrefix: string,
): FeedbackKind | null {
  if (statusCode === 502) return 'gateway_502';
  if (statusCode === 504) return 'gateway_504';
  if (statusCode !== 403) return null;
  const normalized = bodyPrefix.toLowerCase();
  if (
    normalized.includes('just a moment')
    || normalized.includes('cf-chl-')
    || normalized.includes('challenge-platform')
    || normalized.includes('cloudflare ray id')
  ) {
    return 'cloudflare_challenge';
  }
  return null;
}

export function classifyResinTransportFailure(error: unknown): FeedbackKind | null {
  if (!(error instanceof Error)) return null;
  const value = error as Error & { code?: string; cause?: unknown };
  const message = `${value.message || ''} ${(value.cause as Error | undefined)?.message || ''}`.toLowerCase();
  const code = String(value.code || (value.cause as { code?: unknown } | undefined)?.code || '').toUpperCase();
  if (message.includes('abort') || message.includes('canceled') || message.includes('cancelled')) return null;
  if (message.includes('tls') || message.includes('certificate') || message.includes('ssl')) return 'transport_tls';
  if (code === 'ETIMEDOUT' || code.includes('TIMEOUT') || message.includes('timed out') || message.includes('timeout')) {
    return 'transport_timeout';
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || message.includes('reset by peer')) {
    return 'transport_reset';
  }
  if (TRANSPORT_CODES.has(code) || message.includes('socks') || message.includes('connection refused')) {
    return 'transport_connect';
  }
  return null;
}

function feedbackToken(): string {
  const path = config.resinEgressGuardTokenFile;
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

function targetHost(options: Dispatcher.DispatchOptions): string {
  try {
    return new URL(String(options.origin || '')).hostname;
  } catch {
    return '';
  }
}

async function emitFeedback(input: {
  identity: ResinProxyIdentity;
  kind: FeedbackKind;
  targetHost: string;
  statusCode?: number;
}): Promise<void> {
  const endpoint = config.resinEgressGuardUrl;
  const token = feedbackToken();
  if (!endpoint || !token) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.resinEgressGuardTimeoutMs);
  timer.unref?.();
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: 1,
        event_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        source: 'metapi',
        proxy_host: input.identity.proxyHost,
        proxy_port: input.identity.proxyPort,
        platform: input.identity.platform,
        account: input.identity.account,
        kind: input.kind,
        target_host: input.targetHost,
        http_status: input.statusCode || 0,
      }),
      signal: controller.signal,
    });
  } catch {
    // Feedback is best-effort; the original upstream result must still finish.
  } finally {
    clearTimeout(timer);
  }
}

export function withResinEgressFeedback(
  dispatcher: Dispatcher,
  proxyUrl: string,
): Dispatcher {
  const identity = parseResinProxyIdentity(proxyUrl);
  if (!identity || !config.resinEgressGuardUrl || !config.resinEgressGuardTokenFile) {
    return dispatcher;
  }

  return dispatcher.compose((dispatch) => (options, handler) => {
    let statusCode = 0;
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    const host = targetHost(options);

    return dispatch(options, {
      onConnect: (abort) => handler.onConnect?.(abort),
      onResponseStarted: () => handler.onResponseStarted?.(),
      onHeaders: (nextStatusCode, headers, resume, statusText) => {
        if (nextStatusCode >= 200) statusCode = nextStatusCode;
        return handler.onHeaders?.(nextStatusCode, headers, resume, statusText) ?? true;
      },
      onData: (chunk) => {
        if (statusCode === 403 && capturedBytes < BODY_PREFIX_LIMIT) {
          const remaining = BODY_PREFIX_LIMIT - capturedBytes;
          const part = chunk.subarray(0, remaining);
          chunks.push(Buffer.from(part));
          capturedBytes += part.length;
        }
        return handler.onData?.(chunk) ?? true;
      },
      onBodySent: (chunkSize, totalBytesSent) => handler.onBodySent?.(chunkSize, totalBytesSent),
      onUpgrade: (upgradeStatus, headers, socket) => handler.onUpgrade?.(upgradeStatus, headers, socket),
      onComplete: (trailers) => {
        const kind = classifyResinResponseFailure(statusCode, Buffer.concat(chunks).toString('utf8'));
        if (!kind) {
          handler.onComplete?.(trailers);
          return;
        }
        void emitFeedback({ identity, kind, targetHost: host, statusCode })
          .finally(() => handler.onComplete?.(trailers));
      },
      onError: (error) => {
        const kind = classifyResinTransportFailure(error);
        if (!kind) {
          handler.onError?.(error);
          return;
        }
        void emitFeedback({ identity, kind, targetHost: host })
          .finally(() => handler.onError?.(error));
      },
    });
  });
}
