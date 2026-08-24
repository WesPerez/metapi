import React, { Suspense, lazy, useState, useEffect, useRef } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { ToastProvider, useToast } from './components/Toast.js';
import TooltipLayer from './components/TooltipLayer.js';
import { clearAuthSession, hasValidAuthSession, persistAuthSession } from './authSession.js';
import {
  LEGACY_THEME_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
  USER_PROFILE_STORAGE_KEY,
} from './appLocalState.js';
import { I18nProvider, useI18n } from './i18n.js';
import { resolveLoginErrorMessage } from './loginError.js';
import { SITE_DOCS_URL, SITE_GITHUB_URL } from './docsLink.js';
import { useAnimatedVisibility } from './components/useAnimatedVisibility.js';
import { useIsMobile } from './components/useIsMobile.js';
import { MobileDrawer } from './components/MobileDrawer.js';
import CenteredModal from './components/CenteredModal.js';

const Accounts = lazy(() => import('./pages/Accounts.js'));
const Settings = lazy(() => import('./pages/Settings.js'));

type ThemeMode = 'system' | 'light' | 'dark';

type UserProfile = {
  name: string;
  avatarSeed: string;
  avatarStyle: string;
};
const DICEBEAR_STYLES = [
  'pixel-art',
  'pixel-art-neutral',
  'bottts',
  'bottts-neutral',
  'identicon',
  'initials',
  'avataaars',
  'avataaars-neutral',
  'personas',
  'lorelei',
  'lorelei-neutral',
  'fun-emoji',
] as const;

type DicebearStyle = typeof DICEBEAR_STYLES[number];

function resolveStoredThemeMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY);
  if (saved === 'system' || saved === 'light' || saved === 'dark') return saved;
  const legacy = localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  if (legacy === 'light' || legacy === 'dark') return legacy;
  return 'system';
}

function createRandomAvatarSeed(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function pickDicebearStyle(seed: string): DicebearStyle {
  const index = hashString(seed || 'default') % DICEBEAR_STYLES.length;
  return DICEBEAR_STYLES[index];
}

function buildDicebearAvatarUrl(style: string, seed: string): string {
  const safeStyle = DICEBEAR_STYLES.includes(style as DicebearStyle)
    ? style
    : pickDicebearStyle(seed);
  const safeSeed = (seed || 'default').trim() || 'default';
  return `https://api.dicebear.com/9.x/${safeStyle}/svg?seed=${encodeURIComponent(safeSeed)}`;
}

function resolveStoredProfile(): UserProfile {
  try {
    const raw = localStorage.getItem(USER_PROFILE_STORAGE_KEY);
    if (!raw) {
      const avatarSeed = createRandomAvatarSeed();
      return { name: '管理员', avatarSeed, avatarStyle: pickDicebearStyle(avatarSeed) };
    }
    const parsed = JSON.parse(raw) as Partial<UserProfile> & { avatar?: string };
    const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
    const avatarSeed = typeof parsed?.avatarSeed === 'string'
      ? parsed.avatarSeed.trim()
      : (typeof parsed?.avatar === 'string' ? parsed.avatar.trim() : '');
    const resolvedSeed = avatarSeed || createRandomAvatarSeed();
    const avatarStyle = typeof parsed?.avatarStyle === 'string'
      ? parsed.avatarStyle.trim()
      : '';
    return {
      name: name || '管理员',
      avatarSeed: resolvedSeed,
      avatarStyle: DICEBEAR_STYLES.includes(avatarStyle as DicebearStyle)
        ? avatarStyle
        : pickDicebearStyle(resolvedSeed),
    };
  } catch {
    const avatarSeed = createRandomAvatarSeed();
    return { name: '管理员', avatarSeed, avatarStyle: pickDicebearStyle(avatarSeed) };
  }
}

export function Login({ onLogin, t }: { onLogin: (token: string) => void; t: (text: string) => string }) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const capabilityRows = [
    {
      title: t('账号签到管理'),
      description: t('集中维护站点账号，自动执行每日签到'),
    },
    {
      title: t('定时任务'),
      description: t('支持 Cron 与固定间隔两种签到调度模式'),
    },
    {
      title: t('系统代理'),
      description: t('为站点请求配置统一代理并随时测试连通性'),
    },
  ];

  const handleLogin = async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/settings/auth/info', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        onLogin(token);
      } else {
        let reason = '';
        try {
          const text = await res.text();
          if (text) {
            try {
              const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
              if (typeof parsed.message === 'string') reason = parsed.message;
              else if (typeof parsed.error === 'string') reason = parsed.error;
              else reason = text;
            } catch {
              reason = text;
            }
          }
        } catch { }
        setError(t(resolveLoginErrorMessage(res.status, reason)));
        setLoading(false);
      }
    } catch {
      setError(t('无法连接到服务器'));
      setLoading(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-surface animate-scale-in">
        <section className="login-brand-panel login-brand-panel-light">
          <div className="login-brand-header">
            <div className="brand-mark-frame brand-mark-frame-hero">
              <div className="brand-mark-canvas">
                <img src="/logo.png" alt="Metapi" className="login-brand-logo" />
              </div>
            </div>
            <div className="login-brand-summary">
              <div className="login-brand-name">Metapi</div>
              <div className="login-brand-kicker">{t('中转站的中转站')}</div>
            </div>
          </div>
          <div className="login-brand-copy-block">
            <p className="login-brand-copy">
              {t('为站点账号签到而生的独立管理入口，保留账号、密码登录与必要运维设置。')}
            </p>
          </div>
          <div className="login-compat-line">{t('账号刷新 · 模型获取 · 定时签到')}</div>
          <div className="login-capability-list">
            {capabilityRows.map((feature, index) => (
              <div key={feature.title} className="login-capability-row">
                <div className="login-capability-index">{String(index + 1).padStart(2, '0')}</div>
                <div className="login-capability-content">
                  <div className="login-capability-title">{feature.title}</div>
                  <p className="login-capability-desc">{feature.description}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="login-brand-footer">
            <a
              href={SITE_GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="login-icon-link"
              aria-label="GitHub"
              title="GitHub"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="login-icon-link-svg">
                <path
                  fill="currentColor"
                  d="M12 2C6.48 2 2 6.59 2 12.25c0 4.53 2.87 8.38 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-1.04-.01-1.88-2.78.62-3.37-1.22-3.37-1.22-.45-1.2-1.11-1.52-1.11-1.52-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.85.09-.67.35-1.12.64-1.38-2.22-.26-4.55-1.15-4.55-5.13 0-1.13.39-2.05 1.03-2.77-.1-.26-.45-1.31.1-2.73 0 0 .84-.28 2.75 1.06A9.3 9.3 0 0 1 12 6.91c.85 0 1.71.12 2.51.35 1.91-1.34 2.75-1.06 2.75-1.06.55 1.42.2 2.47.1 2.73.64.72 1.03 1.64 1.03 2.77 0 3.99-2.34 4.86-4.57 5.12.36.33.68.97.68 1.96 0 1.42-.01 2.56-.01 2.91 0 .27.18.59.69.49A10.27 10.27 0 0 0 22 12.25C22 6.59 17.52 2 12 2Z"
                />
              </svg>
            </a>
            <a
              href={SITE_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="login-doc-link"
            >
              {t('部署文档')}
            </a>
          </div>
        </section>

        <section className="login-auth-stage">
          <div className="login-auth-panel">
            <div className="login-auth-eyebrow">{t('签到管理入口')}</div>
            <h2 className="login-auth-title">{t('登录')}</h2>
            <p className="login-auth-copy">{t('请输入管理密码后继续。')}</p>
            <label className="login-auth-label" htmlFor="admin-token-input">{t('管理密码')}</label>
            <input
              id="admin-token-input"
              type="password"
              placeholder={t('管理密码')}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setError('');
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              className="login-auth-input"
            />
            {error && (
              <div className="alert alert-error animate-shake" style={{ marginBottom: 12 }}>
                {error}
              </div>
            )}
            <button
              onClick={handleLogin}
              disabled={loading || !token}
              className="btn btn-primary login-auth-submit"
            >
              {loading ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />{t('验证中...')}</> : t('登录')}
            </button>
            <div className="login-auth-note">{t('仅校验本地服务访问权限，不会把密码发送到第三方。')}</div>
            <div className="login-auth-footer">
              <span>{t('登录后管理签到账号。')}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function UserProfileModal({
  open,
  profile,
  onClose,
  onSave,
  t,
}: {
  open: boolean;
  profile: UserProfile;
  onClose: () => void;
  onSave: (nextProfile: UserProfile) => void;
  t: (text: string) => string;
}) {
  const [name, setName] = useState(profile.name);
  const [avatarSeed, setAvatarSeed] = useState(profile.avatarSeed);
  const [avatarStyle, setAvatarStyle] = useState(profile.avatarStyle);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(profile.name);
    setAvatarSeed(profile.avatarSeed);
    setAvatarStyle(profile.avatarStyle);
    setError('');
  }, [open, profile]);

  const avatarUrl = buildDicebearAvatarUrl(avatarStyle, avatarSeed);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 14px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    outline: 'none',
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
  };

  const handleRandomAvatar = () => {
    const nextSeed = createRandomAvatarSeed();
    setAvatarSeed(nextSeed);
    setAvatarStyle(pickDicebearStyle(nextSeed));
  };

  const handleSubmit = () => {
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError(t('用户名不能为空'));
      return;
    }
    if (Array.from(normalizedName).length > 24) {
      setError(t('用户名最多 24 个字符'));
      return;
    }
    onSave({
      name: normalizedName,
      avatarSeed: avatarSeed.trim() || createRandomAvatarSeed(),
      avatarStyle: DICEBEAR_STYLES.includes(avatarStyle as DicebearStyle)
        ? avatarStyle
        : pickDicebearStyle(avatarSeed),
    });
  };

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={t('个人信息')}
      maxWidth={440}
      closeOnBackdrop
      closeOnEscape
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      footer={(
        <>
          <button onClick={onClose} className="btn btn-ghost">{t('取消')}</button>
          <button onClick={handleSubmit} className="btn btn-primary">{t('保存')}</button>
        </>
      )}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
        <div className="topbar-avatar" style={{ width: 40, height: 40, fontSize: 14 }}>
          <img
            src={avatarUrl}
            alt={name.trim() || 'avatar'}
            style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
          />
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{t('右上角头像实时预览')}</div>
      </div>

      <div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{t('用户名')}</div>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError('');
          }}
          placeholder={t('例如：小王')}
          style={inputStyle}
        />
      </div>

      <div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
          {t('头像（Dicebear 随机） · 风格：')}{avatarStyle}
        </div>
        <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={handleRandomAvatar}>
          {t('换一个随机头像')}
        </button>
      </div>

      {error && (
        <div className="alert alert-error">
          {error}
        </div>
      )}
    </CenteredModal>
  );
}

export const sidebarGroups = [
  {
    label: '签到管理',
    items: [
      { to: '/accounts?segment=session', label: '连接管理', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg> },
      { to: '/settings', label: '设置', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg> },
    ],
  },
];

const activeSidebarGroups = sidebarGroups;


function PageTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return <div key={location.pathname} className="page-enter">{children}</div>;
}

function RouteLoadingFallback() {
  return (
    <div className="animate-fade-in" style={{ padding: 16 }}>
      <div className="skeleton" style={{ width: 220, height: 24, marginBottom: 16 }} />
      <div className="skeleton" style={{ width: '100%', height: 120, borderRadius: 12 }} />
    </div>
  );
}

function AppShell() {
  const { language, toggleLanguage, t } = useI18n();
  const [authed, setAuthed] = useState(() => hasValidAuthSession(localStorage));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => resolveStoredThemeMode());
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [userProfile, setUserProfile] = useState<UserProfile>(() => resolveStoredProfile());
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const themeMenuPresence = useAnimatedVisibility(showThemeMenu, 160);
  const userMenuPresence = useAnimatedVisibility(showUserMenu, 160);
  const toast = useToast();
  const isMobile = useIsMobile();
  const resolvedTheme: 'light' | 'dark' = themeMode === 'system'
    ? (systemPrefersDark ? 'dark' : 'light')
    : themeMode;
  const rawDisplayName = (userProfile.name || '').trim();
  const displayName = rawDisplayName ? (rawDisplayName === '管理员' ? t('管理员') : rawDisplayName) : t('管理员');
  const resolvedThemeLabel = resolvedTheme === 'dark' ? t('深色') : t('浅色');
  const avatarUrl = buildDicebearAvatarUrl(userProfile.avatarStyle, userProfile.avatarSeed);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemPrefersDark(media.matches);
    sync();

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', sync);
      return () => media.removeEventListener('change', sync);
    }

    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);
    if (themeMode === 'system') {
      localStorage.removeItem('theme');
    } else {
      localStorage.setItem('theme', themeMode);
    }
  }, [resolvedTheme, themeMode]);

  useEffect(() => {
    document.documentElement.setAttribute('data-layout', isMobile ? 'mobile' : 'desktop');
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile && drawerOpen) {
      setDrawerOpen(false);
    }
  }, [drawerOpen, isMobile]);

  useEffect(() => {
    if (!authed) return;

    const check = () => {
      if (hasValidAuthSession(localStorage)) return;
      setAuthed(false);
      toast.info(t('会话已过期，请重新登录'));
    };

    check();
    const timer = setInterval(check, 60_000);
    return () => clearInterval(timer);
  }, [authed, toast]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target as Node)) {
        setShowThemeMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelectThemeMode = (nextMode: ThemeMode) => {
    setThemeMode(nextMode);
    setShowThemeMenu(false);
  };

  const handleSaveProfile = (nextProfile: UserProfile) => {
    const normalizedSeed = nextProfile.avatarSeed.trim() || createRandomAvatarSeed();
    const normalized = {
      name: nextProfile.name.trim() || t('管理员'),
      avatarSeed: normalizedSeed,
      avatarStyle: DICEBEAR_STYLES.includes(nextProfile.avatarStyle as DicebearStyle)
        ? nextProfile.avatarStyle
        : pickDicebearStyle(normalizedSeed),
    };
    setUserProfile(normalized);
    localStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify(normalized));
    setShowProfileModal(false);
    toast.success(t('个人信息已保存'));
  };

  if (!authed) {
    return <Login t={t} onLogin={(token) => {
      persistAuthSession(localStorage, token);
      setAuthed(true);
    }} />;
  }

  return (
    <>
      <header className="topbar">
        {isMobile && (
          <button
            className="topbar-icon-btn"
            aria-label={t('打开导航')}
            onClick={() => setDrawerOpen(true)}
            type="button"
          >
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        <div className="topbar-logo">
          <img src="/logo.png" alt="Metapi" style={{ width: 28, height: 28, borderRadius: 6 }} />
          <span className="topbar-logo-text">Metapi</span>
        </div>
        <nav className="topbar-nav" />
        <div className="topbar-right">
          <button
            className="topbar-icon-btn"
            aria-label={language === 'zh' ? 'Switch to English' : '切换到中文'}
            onClick={toggleLanguage}
            style={{ minWidth: 36, fontSize: 12, fontWeight: 700 }}
          >
            {language === 'zh' ? 'EN' : '中'}
          </button>
          <div ref={themeMenuRef} style={{ position: 'relative' }}>
            <button
              className="topbar-icon-btn"
              aria-label={themeMode === 'system'
                ? `${t('跟随系统')} (${resolvedThemeLabel})`
                : (themeMode === 'light' ? t('浅色模式') : t('深色模式'))}
              onClick={() => {
                setShowThemeMenu((prev) => !prev);
                setShowUserMenu(false);
              }}
            >
              {themeMode === 'system' ? (
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h16v10H4V5zm6 12h4m-7 2h10" /></svg>
              ) : themeMode === 'light' ? (
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
              ) : (
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
              )}
            </button>
            {themeMenuPresence.shouldRender && (
              <div className={`user-dropdown ${themeMenuPresence.isVisible ? '' : 'is-closing'}`.trim()} style={{ right: 0, left: 'auto', minWidth: 168 }}>
                <button
                  className="user-dropdown-item"
                  onClick={() => handleSelectThemeMode('system')}
                  style={themeMode === 'system' ? { background: 'var(--color-primary-light)', color: 'var(--color-primary)' } : undefined}
                >
                  {t('跟随系统')}（{resolvedThemeLabel}）
                </button>
                <button
                  className="user-dropdown-item"
                  onClick={() => handleSelectThemeMode('light')}
                  style={themeMode === 'light' ? { background: 'var(--color-primary-light)', color: 'var(--color-primary)' } : undefined}
                >
                  {t('浅色模式')}
                </button>
                <button
                  className="user-dropdown-item"
                  onClick={() => handleSelectThemeMode('dark')}
                  style={themeMode === 'dark' ? { background: 'var(--color-primary-light)', color: 'var(--color-primary)' } : undefined}
                >
                  {t('深色模式')}
                </button>
              </div>
            )}
          </div>
          <div ref={userMenuRef} style={{ position: 'relative' }}>
            <button
              type="button"
              className="topbar-avatar"
              aria-label={displayName}
              aria-haspopup="menu"
              aria-expanded={showUserMenu}
              onClick={() => {
                setShowUserMenu(!showUserMenu);
                setShowThemeMenu(false);
              }}
            >
              <img
                src={avatarUrl}
                alt={displayName}
                style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
              />
            </button>
            {userMenuPresence.shouldRender && (
              <div className={`user-dropdown ${userMenuPresence.isVisible ? '' : 'is-closing'}`.trim()}>
                <button
                  className="user-dropdown-item"
                  onClick={() => {
                    setShowProfileModal(true);
                    setShowUserMenu(false);
                  }}
                >
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                  {t('个人信息')}
                </button>
                <button onClick={() => {
                  clearAuthSession(localStorage);
                  setAuthed(false);
                }} className="user-dropdown-item danger">
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                  {t('退出登录')}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="app-layout">
        {isMobile ? (
          <MobileDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            title={t('导航菜单')}
            closeLabel={t('关闭导航')}
          >
            <div className="mobile-drawer-header">
              <img src="/logo.png" alt="Metapi" />
              <span>Metapi</span>
            </div>
            <nav className="mobile-nav">
              {activeSidebarGroups.map((group) => (
                <div key={group.label} className="mobile-nav-group">
                  <div className="mobile-nav-label">{t(group.label)}</div>
                  {group.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/' || item.to === '/settings'}
                      className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}
                      onClick={() => setDrawerOpen(false)}
                    >
                      {item.icon}
                      <span>{t(item.label)}</span>
                    </NavLink>
                  ))}
                </div>
              ))}
            </nav>
          </MobileDrawer>
        ) : (
          <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
            {activeSidebarGroups.map((group) => (
              <div key={group.label} className="sidebar-group">
                {!sidebarCollapsed && <div className="sidebar-group-label">{t(group.label)}</div>}
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/' || item.to === '/settings'}
                    className={({ isActive }) => `sidebar-item ${isActive ? 'active' : ''}`}
                    data-tooltip={sidebarCollapsed ? t(item.label) : undefined}
                    aria-label={sidebarCollapsed ? t(item.label) : undefined}
                  >
                    {item.icon}
                    {!sidebarCollapsed && <span>{t(item.label)}</span>}
                  </NavLink>
                ))}
              </div>
            ))}
            <button className="sidebar-collapse-btn" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ transform: sidebarCollapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.3s ease', flexShrink: 0 }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
              {!sidebarCollapsed && <span>{t('收起侧边栏')}</span>}
            </button>
          </aside>
        )}

        <main className="main-content">
          <PageTransition>
            <Suspense fallback={<RouteLoadingFallback />}>
              <Routes>
                <Route path="/accounts" element={<Accounts />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/accounts?segment=session" replace />} />
              </Routes>
            </Suspense>
          </PageTransition>
        </main>
      </div>

      <UserProfileModal
        open={showProfileModal}
        profile={userProfile}
        onClose={() => setShowProfileModal(false)}
        onSave={handleSaveProfile}
        t={t}
      />
    </>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <AppShell />
        <TooltipLayer />
      </ToastProvider>
    </I18nProvider>
  );
}
