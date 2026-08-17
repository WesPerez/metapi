import type { ApiTokenInfo, BalanceInfo, CheckinResult, TokenVerifyResult, UserInfo } from './base.js';
import { NewApiAdapter } from './newApi.js';
import {
  buildAnyRouterSessionCookieHeader,
  fetchAnyRouterJsonWithCurl,
  isAnyRouterSessionCredential,
} from './anyrouterCurl.js';

export class AnyRouterAdapter extends NewApiAdapter {
  readonly platformName = 'anyrouter';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('anyrouter');
  }

  private buildUserHeaders(platformUserId?: number): Record<string, string> {
    if (!platformUserId) return {};
    const value = String(platformUserId);
    return {
      'New-Api-User': value,
      'Veloera-User': value,
      'voapi-user': value,
      'User-id': value,
      'X-User-Id': value,
      'Rix-Api-User': value,
      'neo-api-user': value,
    };
  }

  private parseAnyRouterUserInfo(data: any): UserInfo {
    return {
      username: data?.username || data?.display_name || '',
      displayName: data?.display_name,
      email: data?.email,
      role: data?.role,
    };
  }

  private parseAnyRouterBalance(data: any): BalanceInfo {
    const balance = Number(data?.quota || 0) / 500_000;
    const used = Number(data?.used_quota || 0) / 500_000;
    const todayIncome = Number.isFinite(data?.today_income)
      ? Number(data.today_income) / 500_000
      : undefined;
    const todayQuotaConsumption = Number.isFinite(data?.today_quota_consumption)
      ? Number(data.today_quota_consumption) / 500_000
      : undefined;
    return {
      balance,
      used,
      quota: balance + used,
      todayIncome,
      todayQuotaConsumption,
    };
  }

  private parseAnyRouterTokenItems(payload: any): ApiTokenInfo[] {
    const items = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.data?.items)
        ? payload.data.items
        : Array.isArray(payload?.items)
          ? payload.items
          : [];
    return items.flatMap((item: any, index: number) => {
      const key = typeof item?.key === 'string' ? item.key.trim() : '';
      if (!key) return [];
      const group = typeof item?.group === 'string'
        ? item.group.trim()
        : (typeof item?.group_name === 'string' ? item.group_name.trim() : '');
      return [{
        name: (typeof item?.name === 'string' && item.name.trim()) || (index === 0 ? 'default' : `token-${index + 1}`),
        key,
        enabled: typeof item?.status === 'number' ? item.status === 1 : true,
        tokenGroup: group || null,
      }];
    });
  }

  private async getSessionSelf(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<any> {
    return fetchAnyRouterJsonWithCurl<any>(`${baseUrl}/api/user/self`, {
      cookieHeader: buildAnyRouterSessionCookieHeader(accessToken),
      headers: this.buildUserHeaders(platformUserId),
    });
  }

  override async getUserInfo(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<UserInfo | null> {
    if (isAnyRouterSessionCredential(accessToken)) {
      try {
        const payload = await this.getSessionSelf(baseUrl, accessToken, platformUserId);
        if (payload?.success && payload?.data) return this.parseAnyRouterUserInfo(payload.data);
      } catch {}
    }
    return super.getUserInfo(baseUrl, accessToken, platformUserId);
  }

  override async verifyToken(
    baseUrl: string,
    token: string,
    platformUserId?: number,
  ): Promise<TokenVerifyResult> {
    if (isAnyRouterSessionCredential(token)) {
      try {
        const payload = await this.getSessionSelf(baseUrl, token, platformUserId);
        if (payload?.success && payload?.data) {
          let apiToken: string | null = null;
          try { apiToken = await this.getApiToken(baseUrl, token, payload.data.id || platformUserId); } catch {}
          return {
            tokenType: 'session',
            userInfo: this.parseAnyRouterUserInfo(payload.data),
            balance: this.parseAnyRouterBalance(payload.data),
            apiToken,
          };
        }
      } catch {}
    }
    return super.verifyToken(baseUrl, token, platformUserId);
  }

  override async getBalance(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<BalanceInfo> {
    if (isAnyRouterSessionCredential(accessToken)) {
      let curlError: unknown;
      try {
        const payload = await this.getSessionSelf(baseUrl, accessToken, platformUserId);
        if (payload?.success && payload?.data) return this.parseAnyRouterBalance(payload.data);
        throw new Error(payload?.message || 'AnyRouter balance refresh failed');
      } catch (error) {
        curlError = error;
      }
      try {
        return await super.getBalance(baseUrl, accessToken, platformUserId);
      } catch {
        throw curlError;
      }
    }
    return super.getBalance(baseUrl, accessToken, platformUserId);
  }

  override async checkin(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<CheckinResult> {
    if (!isAnyRouterSessionCredential(accessToken)) {
      return super.checkin(baseUrl, accessToken, platformUserId);
    }

    const cookieHeader = buildAnyRouterSessionCookieHeader(accessToken);
    let failureMessage = '';
    try {
      const signIn = await fetchAnyRouterJsonWithCurl<any>(`${baseUrl}/api/user/sign_in`, {
        method: 'POST',
        body: '{}',
        cookieHeader,
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        useHelper: false,
      });
      if (signIn?.success) {
        return {
          success: true,
          message: signIn.message || 'checked in',
          reward: signIn.data?.reward?.toString(),
        };
      }
      failureMessage = typeof signIn?.message === 'string' ? signIn.message : '';
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error || '');
    }

    try {
      const checkin = await fetchAnyRouterJsonWithCurl<any>(`${baseUrl}/api/user/checkin`, {
        method: 'POST',
        cookieHeader,
        headers: this.buildUserHeaders(platformUserId),
        useHelper: false,
      });
      return {
        success: checkin?.success === true,
        message: checkin?.message || failureMessage || 'checkin failed',
        reward: checkin?.data?.reward?.toString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '');
      return { success: false, message: message || failureMessage || 'checkin failed' };
    }
  }

  override async getApiTokens(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<ApiTokenInfo[]> {
    if (isAnyRouterSessionCredential(accessToken)) {
      try {
        const payload = await fetchAnyRouterJsonWithCurl<any>(`${baseUrl}/api/token/?p=0&size=100`, {
          cookieHeader: buildAnyRouterSessionCookieHeader(accessToken),
          headers: this.buildUserHeaders(platformUserId),
        });
        const tokens = this.parseAnyRouterTokenItems(payload);
        if (tokens.length > 0) return tokens;
      } catch {}
    }
    return super.getApiTokens(baseUrl, accessToken, platformUserId);
  }

  override async getApiToken(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<string | null> {
    if (isAnyRouterSessionCredential(accessToken)) {
      const tokens = await this.getApiTokens(baseUrl, accessToken, platformUserId);
      return tokens.find((token) => token.enabled !== false)?.key || null;
    }
    return super.getApiToken(baseUrl, accessToken, platformUserId);
  }

  override async getModels(
    baseUrl: string,
    token: string,
    platformUserId?: number,
  ): Promise<string[]> {
    try {
      if (isAnyRouterSessionCredential(token)) {
        const payload = await fetchAnyRouterJsonWithCurl<any>(`${baseUrl}/api/user/models`, {
          cookieHeader: buildAnyRouterSessionCookieHeader(token),
          headers: this.buildUserHeaders(platformUserId),
        });
        if (Array.isArray(payload?.data)) return payload.data.filter(Boolean);
        if (payload?.data && typeof payload.data === 'object') return Object.keys(payload.data).filter(Boolean);
      } else {
        const payload = await fetchAnyRouterJsonWithCurl<any>(`${baseUrl}/v1/models`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const models = Array.isArray(payload?.data)
          ? payload.data.map((item: any) => item?.id).filter(Boolean)
          : [];
        if (models.length > 0) return models;
      }
    } catch {}
    return super.getModels(baseUrl, token, platformUserId);
  }
}
