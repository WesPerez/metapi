import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collectText(node: any): string {
  return (node.children || []).map((child: any) => (
    typeof child === 'string' ? child : collectText(child)
  )).join('');
}

function createSessionAccount(id: number, username: string) {
  return {
    id,
    siteId: 10,
    username,
    accessToken: `session-${id}`,
    status: 'active',
    credentialMode: 'session',
    capabilities: { canCheckin: true, canRefreshBalance: true, proxyOnly: false },
    site: {
      id: 10,
      name: 'Session Site',
      platform: 'new-api',
      status: 'active',
      url: 'https://session.example.com',
    },
  };
}

describe('Accounts standalone session view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Session Site', platform: 'new-api', status: 'active' },
    ]);
  });

  afterEach(() => vi.clearAllMocks());

  it('shows existing-site guidance for an empty account list', async () => {
    apiMock.getAccounts.mockResolvedValue([]);
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider><Accounts /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('账号管理');
      expect(rendered).toContain('暂无 Session 连接');
      expect(rendered).toContain('请为现有站点添加 Session 连接');
      expect(rendered).not.toContain('API Key管理');
      expect(rendered).not.toContain('账号令牌管理');
    } finally {
      root?.unmount();
    }
  });

  it('paginates session accounts', async () => {
    apiMock.getAccounts.mockResolvedValue(
      Array.from({ length: 16 }, (_, index) => createSessionAccount(index + 1, `session-${index + 1}`)),
    );
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider><Accounts /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      let rows = root.root.findAll((node) => (
        typeof node.props['data-testid'] === 'string'
        && node.props['data-testid'].startsWith('account-row-')
      ));
      expect(rows).toHaveLength(15);
      expect(collectText(root.root)).toContain('显示第 1 - 15 条，共 16 条');

      const nextButton = root.root.findAll((node) => (
        node.type === 'button' && collectText(node) === '下一页'
      )).at(-1);
      await act(async () => nextButton!.props.onClick());
      await flushMicrotasks();

      rows = root.root.findAll((node) => (
        typeof node.props['data-testid'] === 'string'
        && node.props['data-testid'].startsWith('account-row-')
      ));
      expect(rows.map((node) => node.props['data-testid'])).toEqual(['account-row-16']);
    } finally {
      root?.unmount();
    }
  });
});
