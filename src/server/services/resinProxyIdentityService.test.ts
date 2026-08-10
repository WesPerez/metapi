import { describe, expect, it } from 'vitest';
import { buildAccountScopedResinProxyUrl } from './resinProxyIdentityService.js';

const endpoints = new Set(['172.20.0.1:10834']);

describe('resinProxyIdentityService', () => {
  it('derives an account-scoped identity from shared MetAPI Resin users', () => {
    const result = buildAccountScopedResinProxyUrl(
      'socks5h://AppsGlobal.metapi-site-15:secret@172.20.0.1:10834',
      40,
      endpoints,
    );
    const parsed = new URL(result || '');
    expect(decodeURIComponent(parsed.username)).toBe('AppsGlobal.metapi-account-40');
    expect(parsed.password).toBe('secret');
    expect(parsed.hostname).toBe('172.20.0.1');
    expect(parsed.port).toBe('10834');
  });

  it('keeps existing account-specific identities unchanged', () => {
    expect(buildAccountScopedResinProxyUrl(
      'socks5h://AppsGlobal.metapi-site-15-115-v2:secret@172.20.0.1:10834',
      115,
      endpoints,
    )).toBeNull();
  });

  it('does not rewrite an unconfigured proxy endpoint', () => {
    expect(buildAccountScopedResinProxyUrl(
      'socks5h://AppsGlobal.metapi-system:secret@127.0.0.1:1080',
      40,
      endpoints,
    )).toBeNull();
  });
});
