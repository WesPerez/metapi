import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RetryAgent, type Dispatcher } from 'undici';
import { config } from '../config.js';

const BODY_PREFIX_LIMIT = 32 * 1024;
const RESIN_PROXY_PROTOCOLS = new Set(['socks:', 'socks5:', 'socks5h:']);
const TRANSPORT_CODES = new Set([
  'EHOSTDOWN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const TLS_CONFIGURATION_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const RETRYABLE_METHODS: Dispatcher.HttpMethod[] = [
  'GET',
  'HEAD',
  'OPTIONS',
  'PUT',
  'DELETE',
  'TRACE',
  'POST',
  'PATCH',
];
const RETRY_READY_STATUSES = new Set(['deleted', 'lease_absent', 'stale_node']);
const NATIVE_RESIN_RETRY_STATUS = 'native_resin';
const NATIVE_RESIN_RETRY_KINDS = new Set<FeedbackKind>([
  'transport_connect',
  'transport_timeout',
  'transport_reset',
]);
const RESPONSE_STARTED = Symbol('metapi.resinResponseStarted');
const FEEDBACK_STATUS = Symbol('metapi.resinFeedbackStatus');

export type ResinProxyIdentity = {
  proxyHost: string;
  proxyPort: number;
  platform: string;
  account: string;
};

type FeedbackKind =
  | 'cloudflare_challenge'
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
  if (
    TLS_CONFIGURATION_CODES.has(code)
    || message.includes('certificate has expired')
    || message.includes('hostname/ip does not match certificate')
    || message.includes('self-signed certificate')
    || message.includes('unable to verify the first certificate')
  ) {
    return null;
  }
  if (message.includes('tls') || message.includes('ssl')) return 'transport_tls';
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

type RecoveryTaggedError = Error & {
  [RESPONSE_STARTED]?: boolean;
  [FEEDBACK_STATUS]?: string;
};

function markRecoveryMetadata(error: Error, responseStarted: boolean, feedbackStatus: string): void {
  try {
    Object.defineProperties(error, {
      [RESPONSE_STARTED]: {
        configurable: true,
        enumerable: false,
        value: responseStarted,
      },
      [FEEDBACK_STATUS]: {
        configurable: true,
        enumerable: false,
        value: feedbackStatus,
      },
    });
  } catch {
    // Frozen third-party errors simply remain ineligible for automatic replay.
  }
}

export function shouldRetryResinTransportFailure(
  error: unknown,
  retryCounter: number,
  feedbackStatus?: string,
  responseStarted?: boolean,
): boolean {
  if (!(error instanceof Error) || retryCounter > 2) return false;
  const tagged = error as RecoveryTaggedError;
  if (responseStarted ?? tagged[RESPONSE_STARTED] ?? false) return false;
  const status = feedbackStatus ?? tagged[FEEDBACK_STATUS] ?? '';
  const kind = classifyResinTransportFailure(error);
  if (!kind) return false;
  if (status === NATIVE_RESIN_RETRY_STATUS) {
    return NATIVE_RESIN_RETRY_KINDS.has(kind);
  }
  return RETRY_READY_STATUSES.has(status);
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
}): Promise<string> {
  const endpoint = config.resinEgressGuardUrl;
  const token = feedbackToken();
  if (!endpoint || !token) return 'disabled';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.resinEgressGuardTimeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(endpoint, {
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
    const rawBody = await response.text();
    if (!response.ok) return `http_${response.status}`;
    try {
      const payload = JSON.parse(rawBody) as { status?: unknown };
      return typeof payload.status === 'string' ? payload.status : 'unknown';
    } catch {
      return 'invalid_response';
    }
  } catch {
    // Feedback is best-effort; the original upstream result must still finish.
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

export function withResinEgressFeedback(
  dispatcher: Dispatcher,
  proxyUrl: string,
): Dispatcher {
  const identity = parseResinProxyIdentity(proxyUrl);
  if (!identity) return dispatcher;
  const feedbackEnabled = !!config.resinEgressGuardUrl && !!config.resinEgressGuardTokenFile;

  const feedbackDispatcher = dispatcher.compose((dispatch) => (options, handler) => {
    let statusCode = 0;
    let responseStarted = false;
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    const host = targetHost(options);

    return dispatch(options, {
      onConnect: (abort) => handler.onConnect?.(abort),
      onResponseStarted: () => {
        responseStarted = true;
        handler.onResponseStarted?.();
      },
      onHeaders: (nextStatusCode, headers, resume, statusText) => {
        if (nextStatusCode >= 200) {
          statusCode = nextStatusCode;
          responseStarted = true;
        }
        return handler.onHeaders?.(nextStatusCode, headers, resume, statusText) ?? true;
      },
      onData: (chunk) => {
        responseStarted = true;
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
        if (!feedbackEnabled) {
          handler.onComplete?.(trailers);
          return;
        }
        void emitFeedback({ identity, kind, targetHost: host, statusCode })
          .finally(() => handler.onComplete?.(trailers));
      },
      onError: (error) => {
        const kind = classifyResinTransportFailure(error);
        if (!kind) {
          markRecoveryMetadata(error, responseStarted, 'not_eligible');
          handler.onError?.(error);
          return;
        }
        if (!feedbackEnabled) {
          const status = NATIVE_RESIN_RETRY_KINDS.has(kind)
            ? NATIVE_RESIN_RETRY_STATUS
            : 'not_eligible';
          markRecoveryMetadata(error, responseStarted, status);
          handler.onError?.(error);
          return;
        }
        void emitFeedback({ identity, kind, targetHost: host })
          .then((feedbackStatus) => {
            markRecoveryMetadata(error, responseStarted, feedbackStatus);
            handler.onError?.(error);
          });
      },
    });
  });

  return new RetryAgent(feedbackDispatcher, {
    maxRetries: 2,
    minTimeout: 0,
    maxTimeout: 0,
    timeoutFactor: 1,
    retryAfter: false,
    methods: RETRYABLE_METHODS,
    statusCodes: [],
    errorCodes: [...TRANSPORT_CODES],
    retry: (error, context, callback) => {
      if (!shouldRetryResinTransportFailure(error, context.state.counter)) {
        callback(error);
        return;
      }
      callback(null);
    },
  });
}
