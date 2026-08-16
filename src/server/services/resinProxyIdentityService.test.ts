import { describe, expect, it } from 'vitest';
import {
  buildAccountScopedResinProxyUrl,
  buildNextAccountScopedResinProxyUrl,
} from './resinProxyIdentityService.js';

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

describe('buildNextAccountScopedResinProxyUrl', () => {
  const endpoints = new Set(['172.20.0.1:10834']);

  it('cycles through three bounded sticky identities', () => {
    const base = 'socks5h://AppsGlobal.metapi-account-40:secret@172.20.0.1:10834';
    const slot1 = buildNextAccountScopedResinProxyUrl(base, 40, endpoints);
    const slot2 = buildNextAccountScopedResinProxyUrl(slot1, 40, endpoints);
    const slot0 = buildNextAccountScopedResinProxyUrl(slot2, 40, endpoints);

    expect(decodeURIComponent(new URL(slot1!).username)).toBe('AppsGlobal.metapi-account-40-slot-1');
    expect(decodeURIComponent(new URL(slot2!).username)).toBe('AppsGlobal.metapi-account-40-slot-2');
    expect(decodeURIComponent(new URL(slot0!).username)).toBe('AppsGlobal.metapi-account-40');
  });

  it('rejects another account identity and non-Resin endpoints', () => {
    expect(buildNextAccountScopedResinProxyUrl(
      'socks5h://AppsGlobal.metapi-account-41:secret@172.20.0.1:10834',
      40,
      endpoints,
    )).toBeNull();
    expect(buildNextAccountScopedResinProxyUrl(
      'socks5h://AppsGlobal.metapi-account-40:secret@proxy.example.com:1080',
      40,
      endpoints,
    )).toBeNull();
  });
});
