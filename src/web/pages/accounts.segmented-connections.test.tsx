import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    getAccountTokens: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collectText(node: ReactTestInstance): string {
  return (node.children || [])
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join('');
}

function createApiKeyAccount(id: number, siteId: number, siteName: string, name = `key-${id}`) {
  return {
    id,
    siteId,
    username: name,
    accessToken: '',
    apiToken: `sk-${id}`,
    status: 'active',
    credentialMode: 'apikey',
    capabilities: { canCheckin: false, canRefreshBalance: false, proxyOnly: true },
    enabledModels: ['gpt-4o'],
    site: { id: siteId, name: siteName, platform: 'new-api', status: 'active', url: `https://${siteName.toLowerCase()}.example.com` },
  };
}

describe('Accounts segmented connections view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows only apikey connections in the apikey segment and labels unnamed ones as API Key 连接', async () => {
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        username: 'session-user',
        accessToken: 'session-token',
        apiToken: 'sk-session',
        status: 'active',
        credentialMode: 'session',
        capabilities: { canCheckin: true, canRefreshBalance: true, proxyOnly: false },
        site: { id: 10, name: 'Session Site', platform: 'new-api', status: 'active', url: 'https://session.example.com' },
      },
      {
        id: 2,
        username: '',
        accessToken: '',
        apiToken: 'sk-apikey',
        status: 'active',
        credentialMode: 'apikey',
        capabilities: { canCheckin: false, canRefreshBalance: false, proxyOnly: true },
        enabledModels: ['gpt-4o', 'claude-sonnet'],
        site: { id: 11, name: 'Key Site', platform: 'new-api', status: 'active', url: 'https://key.example.com' },
      },
    ]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Session Site', platform: 'new-api', status: 'active' },
      { id: 11, name: 'Key Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=apikey']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('连接管理');
      expect(rendered).toContain('账号管理');
      expect(rendered).toContain('API Key管理');
      expect(rendered).toContain('账号令牌管理');
      expect(rendered).toContain('用于签到、余额、状态维护');
      expect(rendered).toContain('只有 Base URL + Key 时使用，只负责代理调用');
      expect(rendered).toContain('从账号同步或手动维护，供路由实际调用');
      expect(rendered).toContain('Key Site');
      expect(rendered).toContain('启用模型');
      expect(rendered).toContain('gpt-4o');
      expect(rendered).toContain('claude-sonnet');
      expect(rendered).not.toContain('仅代理');
      expect(rendered).not.toContain('session-user');

      const segmentButtons = root.root.findAll((node) => {
        if (node.type !== 'button') return false;
        const text = collectText(node);
        return text === '账号管理' || text === 'API Key管理' || text === '账号令牌管理';
      });
      expect(segmentButtons).toHaveLength(3);
      expect(segmentButtons[0]?.props['data-tooltip-side']).toBe('bottom');
      expect(segmentButtons[0]?.props['data-tooltip-align']).toBe('start');
      expect(segmentButtons[1]?.props['data-tooltip-side']).toBe('bottom');
      expect(segmentButtons[1]?.props['data-tooltip-align']).toBe('center');
      expect(segmentButtons[2]?.props['data-tooltip-side']).toBe('bottom');
      expect(segmentButtons[2]?.props['data-tooltip-align']).toBe('end');
    } finally {
      root?.unmount();
    }
  });

  it('uses existing-site guidance instead of asking to add a site when the segment is empty but sites exist', async () => {
    apiMock.getAccounts.mockResolvedValue([]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Session Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('暂无 Session 连接');
      expect(rendered).toContain('请为现有站点添加 Session 连接');
      expect(rendered).not.toContain('请先添加站点');
    } finally {
      root?.unmount();
    }
  });

  it('paginates apikey connections and shows only the current page by default', async () => {
    apiMock.getAccounts.mockResolvedValue(
      Array.from({ length: 16 }, (_, index) => (
        createApiKeyAccount(index + 1, 20, 'Bulk Site', `bulk-key-${String(index + 1).padStart(2, '0')}`)
      )),
    );
    apiMock.getSites.mockResolvedValue([
      { id: 20, name: 'Bulk Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=apikey']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      let rowIds = root.root
        .findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('account-row-'))
        .map((node) => node.props['data-testid']);
      expect(rowIds).toHaveLength(15);
      expect(rowIds).toContain('account-row-15');
      expect(rowIds).not.toContain('account-row-16');
      expect(collectText(root.root)).toContain('显示第 1 - 15 条，共 16 条');

      const nextButton = root.root
        .findAll((node) => node.type === 'button' && collectText(node) === '下一页')
        .at(-1);
      expect(nextButton).toBeTruthy();
      await act(async () => {
        nextButton!.props.onClick();
      });
      await flushMicrotasks();

      rowIds = root.root
        .findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('account-row-'))
        .map((node) => node.props['data-testid']);
      expect(rowIds).toEqual(['account-row-16']);
      expect(collectText(root.root)).toContain('显示第 16 - 16 条，共 16 条');
    } finally {
      root?.unmount();
    }
  });

  it('keeps apikey connections from the same site adjacent in the visible order', async () => {
    apiMock.getAccounts.mockResolvedValue([
      createApiKeyAccount(1, 10, 'Alpha Site', 'alpha-a'),
      createApiKeyAccount(2, 20, 'Beta Site', 'beta-a'),
      createApiKeyAccount(3, 10, 'Alpha Site', 'alpha-b'),
      createApiKeyAccount(4, 20, 'Beta Site', 'beta-b'),
    ]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Alpha Site', platform: 'new-api', status: 'active' },
      { id: 20, name: 'Beta Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=apikey']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const rowIds = root.root
        .findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('account-row-'))
        .map((node) => node.props['data-testid']);
      expect(rowIds).toEqual(['account-row-1', 'account-row-3', 'account-row-2', 'account-row-4']);
    } finally {
      root?.unmount();
    }
  });
});
