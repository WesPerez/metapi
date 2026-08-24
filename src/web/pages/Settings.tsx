import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import ChangeKeyModal from '../components/ChangeKeyModal.js';
import ModernSelect from '../components/ModernSelect.js';
import { useToast } from '../components/Toast.js';
import { useIsMobile } from '../components/useIsMobile.js';

const CHECKIN_SCHEDULE_MODE_OPTIONS = [
  { value: 'cron', label: 'Cron' },
  { value: 'interval', label: '间隔签到' },
] as const;

const CHECKIN_INTERVAL_OPTIONS = Array.from({ length: 24 }, (_, index) => ({
  value: String(index + 1),
  label: `${index + 1} 小时`,
}));

type RuntimeSettings = {
  checkinCron: string;
  checkinScheduleMode: 'cron' | 'interval';
  checkinIntervalHours: number;
  systemProxyUrl: string;
};

type SystemProxyTestState =
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string }
  | null;

const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  checkinCron: '0 8 * * *',
  checkinScheduleMode: 'cron',
  checkinIntervalHours: 6,
  systemProxyUrl: '',
};

export default function Settings() {
  const isMobile = useIsMobile();
  const toast = useToast();
  const [runtime, setRuntime] = useState<RuntimeSettings>(DEFAULT_RUNTIME_SETTINGS);
  const [maskedToken, setMaskedToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [showChangeKey, setShowChangeKey] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [testingCheckin, setTestingCheckin] = useState(false);
  const [savingSystemProxy, setSavingSystemProxy] = useState(false);
  const [testingSystemProxy, setTestingSystemProxy] = useState(false);
  const [systemProxyTestState, setSystemProxyTestState] = useState<SystemProxyTestState>(null);

  useEffect(() => {
    let active = true;

    const loadSettings = async () => {
      setLoading(true);
      try {
        const [authInfo, runtimeInfo] = await Promise.all([
          api.getAuthInfo(),
          api.getRuntimeSettings(),
        ]);
        if (!active) return;
        setMaskedToken(authInfo.masked || '****');
        setRuntime({
          checkinCron: runtimeInfo.checkinCron || DEFAULT_RUNTIME_SETTINGS.checkinCron,
          checkinScheduleMode: runtimeInfo.checkinScheduleMode === 'interval' ? 'interval' : 'cron',
          checkinIntervalHours: Number(runtimeInfo.checkinIntervalHours) >= 1
            ? Math.min(24, Math.trunc(Number(runtimeInfo.checkinIntervalHours)))
            : DEFAULT_RUNTIME_SETTINGS.checkinIntervalHours,
          systemProxyUrl: typeof runtimeInfo.systemProxyUrl === 'string' ? runtimeInfo.systemProxyUrl : '',
        });
      } catch (error: any) {
        if (active) toast.error(error?.message || '加载设置失败');
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadSettings();
    return () => {
      active = false;
    };
  }, [toast]);

  const saveSchedule = async () => {
    setSavingSchedule(true);
    try {
      await api.updateRuntimeSettings({
        checkinCron: runtime.checkinCron,
        checkinScheduleMode: runtime.checkinScheduleMode,
        checkinIntervalHours: runtime.checkinIntervalHours,
      });
      toast.success('定时任务设置已保存');
    } catch (error: any) {
      toast.error(error?.message || '保存失败');
    } finally {
      setSavingSchedule(false);
    }
  };

  const triggerScheduleCheckin = async () => {
    setTestingCheckin(true);
    try {
      await api.triggerCheckinAll();
      toast.success('已开始全部签到，请稍后查看签到日志');
    } catch (error: any) {
      toast.error(error?.message || '触发签到失败');
    } finally {
      setTestingCheckin(false);
    }
  };

  const saveSystemProxy = async () => {
    setSavingSystemProxy(true);
    try {
      const response = await api.updateRuntimeSettings({
        systemProxyUrl: runtime.systemProxyUrl.trim(),
      });
      setRuntime((current) => ({
        ...current,
        systemProxyUrl: typeof response?.systemProxyUrl === 'string'
          ? response.systemProxyUrl
          : current.systemProxyUrl,
      }));
      toast.success('系统代理已保存');
    } catch (error: any) {
      toast.error(error?.message || '保存失败');
    } finally {
      setSavingSystemProxy(false);
    }
  };

  const testSystemProxy = async () => {
    const proxyUrl = runtime.systemProxyUrl.trim();
    if (!proxyUrl) {
      const message = '请先填写系统代理地址';
      setSystemProxyTestState({ kind: 'error', text: message });
      toast.info(message);
      return;
    }

    setTestingSystemProxy(true);
    setSystemProxyTestState(null);
    try {
      const response = await api.testSystemProxy({ proxyUrl });
      const summary = `连通成功，延迟 ${response.latencyMs} ms`;
      setSystemProxyTestState({ kind: 'success', text: summary });
      toast.success(`系统代理测试成功（${response.latencyMs} ms）`);
    } catch (error: any) {
      const message = error?.message || '系统代理测试失败';
      setSystemProxyTestState({ kind: 'error', text: message });
      toast.error(message);
    } finally {
      setTestingSystemProxy(false);
    }
  };

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

  if (loading) {
    return (
      <div className="animate-fade-in">
        <div className="skeleton" style={{ width: 220, height: 28, marginBottom: 20 }} />
        <div className="skeleton" style={{ width: '100%', height: 320, borderRadius: 'var(--radius-sm)' }} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h2 className="page-title">系统设置</h2>
      </div>

      <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section className="card animate-slide-up stagger-1" style={{ padding: 20 }}>
          <h3 style={{ fontWeight: 600, fontSize: 14, margin: '0 0 12px' }}>管理密码</h3>
          <code style={{
            display: 'block',
            padding: '10px 14px',
            background: 'var(--color-bg)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 13,
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text-secondary)',
            border: '1px solid var(--color-border-light)',
            marginBottom: 12,
          }}>
            {maskedToken || '****'}
          </code>
          <button type="button" onClick={() => setShowChangeKey(true)} className="btn btn-primary">
            修改管理密码
          </button>
          <ChangeKeyModal
            open={showChangeKey}
            onClose={() => {
              setShowChangeKey(false);
              api.getAuthInfo()
                .then((response: any) => setMaskedToken(response.masked || '****'))
                .catch(() => undefined);
            }}
          />
        </section>

        <section className="card animate-slide-up stagger-2" style={{ padding: 20 }}>
          <h3 style={{ fontWeight: 600, fontSize: 14, margin: '0 0 12px' }}>定时任务</h3>
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : '180px 180px auto',
            gap: 12,
            alignItems: 'end',
            marginBottom: 12,
          }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>签到方式</span>
              <ModernSelect
                value={runtime.checkinScheduleMode}
                onChange={(value) => setRuntime((current) => ({
                  ...current,
                  checkinScheduleMode: value === 'interval' ? 'interval' : 'cron',
                }))}
                options={CHECKIN_SCHEDULE_MODE_OPTIONS.map((option) => ({ ...option }))}
              />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>签到间隔</span>
              <ModernSelect
                value={String(runtime.checkinIntervalHours)}
                onChange={(value) => setRuntime((current) => ({
                  ...current,
                  checkinIntervalHours: Math.min(24, Math.max(1, Math.trunc(Number(value) || 1))),
                }))}
                disabled={runtime.checkinScheduleMode !== 'interval'}
                options={CHECKIN_INTERVAL_OPTIONS}
              />
            </label>
            <button
              type="button"
              onClick={triggerScheduleCheckin}
              disabled={testingCheckin}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}
            >
              {testingCheckin ? '触发中...' : '测试一次签到'}
            </button>
          </div>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>签到 Cron</span>
            <input
              value={runtime.checkinCron}
              onChange={(event) => setRuntime((current) => ({ ...current, checkinCron: event.target.value }))}
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
              disabled={runtime.checkinScheduleMode !== 'cron'}
            />
          </label>
          <button
            type="button"
            onClick={saveSchedule}
            disabled={savingSchedule}
            className="btn btn-primary"
            style={{ marginTop: 12 }}
          >
            {savingSchedule ? '保存中...' : '保存定时任务'}
          </button>
        </section>

        <section className="card animate-slide-up stagger-3" style={{ padding: 20 }}>
          <h3 style={{ fontWeight: 600, fontSize: 14, margin: '0 0 12px' }}>系统代理</h3>
          <input
            value={runtime.systemProxyUrl}
            onChange={(event) => {
              setRuntime((current) => ({ ...current, systemProxyUrl: event.target.value }));
              setSystemProxyTestState(null);
            }}
            placeholder="系统代理 URL（可选，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）"
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)', marginBottom: 10 }}
          />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" onClick={saveSystemProxy} disabled={savingSystemProxy} className="btn btn-primary">
              {savingSystemProxy ? '保存中...' : '保存系统代理'}
            </button>
            <button
              type="button"
              onClick={testSystemProxy}
              disabled={testingSystemProxy}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
            >
              {testingSystemProxy ? '测试中...' : '测试系统代理'}
            </button>
          </div>
          {systemProxyTestState && (
            <div style={{
              fontSize: 12,
              marginTop: 10,
              color: systemProxyTestState.kind === 'success'
                ? 'var(--color-success)'
                : 'var(--color-danger)',
            }}>
              {systemProxyTestState.text}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
