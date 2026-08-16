import { describe, expect, it } from 'vitest';
import {
  classifyResinResponseFailure,
  classifyResinTransportFailure,
  parseResinProxyIdentity,
  shouldRetryResinTransportFailure,
} from './resinEgressFeedback.js';

describe('resinEgressFeedback', () => {
  it('extracts Platform.Account without exposing proxy credentials', () => {
    expect(parseResinProxyIdentity(
      'socks5h://AppsGlobal.metapi-account-40:secret@172.20.0.1:10834',
      new Set(['172.20.0.1:10834']),
    )).toEqual({
      proxyHost: '172.20.0.1',
      proxyPort: 10834,
      platform: 'AppsGlobal',
      account: 'metapi-account-40',
    });
  });

  it('only classifies a 403 when the body is a Cloudflare challenge', () => {
    expect(classifyResinResponseFailure(403, '<title>Just a moment...</title>'))
      .toBe('cloudflare_challenge');
    expect(classifyResinResponseFailure(403, '{"error":"permission denied"}'))
      .toBeNull();
  });

  it('does not rotate for ordinary upstream status codes', () => {
    expect(classifyResinResponseFailure(401, '')).toBeNull();
    expect(classifyResinResponseFailure(429, '')).toBeNull();
    expect(classifyResinResponseFailure(500, '')).toBeNull();
    expect(classifyResinResponseFailure(502, '')).toBeNull();
    expect(classifyResinResponseFailure(504, '')).toBeNull();
  });

  it('classifies hard transport errors but excludes cancellation', () => {
    expect(classifyResinTransportFailure(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })))
      .toBe('transport_timeout');
    expect(classifyResinTransportFailure(Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' })))
      .toBe('transport_reset');
    expect(classifyResinTransportFailure(new Error('request aborted by caller'))).toBeNull();
  });

  it('does not rotate for an upstream certificate configuration error', () => {
    expect(classifyResinTransportFailure(Object.assign(
      new Error('hostname/IP does not match certificate altnames'),
      { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    ))).toBeNull();
  });

  it('retries one pre-response transport failure after confirmed rotation', () => {
    const error = Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' });
    expect(shouldRetryResinTransportFailure(error, 1, 'deleted')).toBe(true);
    expect(shouldRetryResinTransportFailure(error, 2, 'deleted')).toBe(false);
    expect(shouldRetryResinTransportFailure(error, 1, 'observe_only')).toBe(false);
    expect(shouldRetryResinTransportFailure(error, 1, 'deleted', true)).toBe(false);
    expect(shouldRetryResinTransportFailure(new Error('request aborted by caller'), 1, 'deleted')).toBe(false);
  });
});
