import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('App sidebar config', () => {
  it('keeps only the standalone check-in navigation entries', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');

    expect(source).toContain("{ to: '/accounts?segment=session', label: '连接管理'");
    expect(source).toContain("{ to: '/settings', label: '设置'");
    expect(source).not.toContain("{ to: '/accounts', label: '账号'");
    expect(source).not.toContain("{ to: '/tokens', label: '令牌管理'");
    expect(source).not.toContain("{ to: '/downstream-keys'");
    expect(source).not.toContain("{ to: '/oauth'");
  });

  it('loads only account and settings pages and redirects unknown routes to accounts', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');

    expect(source).toContain("const Accounts = lazy(() => import('./pages/Accounts.js'));");
    expect(source).toContain("const Settings = lazy(() => import('./pages/Settings.js'));");
    expect(source).toContain('<Route path="/accounts" element={<Accounts />} />');
    expect(source).toContain('<Route path="/settings" element={<Settings />} />');
    expect(source).toContain('<Navigate to="/accounts?segment=session" replace />');
    expect(source).not.toContain("lazy(() => import('./pages/OAuthManagement.js'))");
  });
});
