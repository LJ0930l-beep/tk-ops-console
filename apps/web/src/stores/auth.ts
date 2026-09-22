import { defineStore } from 'pinia';
import { apiGet, apiPost } from '@/api/client';
import type { ApiPath } from '@/api/paths';
import type { CurrentUser } from '@tk/shared';

interface LoginResp { token: string; user: CurrentUser }

export const useAuthStore = defineStore('auth', {
  state: () => ({ token: localStorage.getItem('tk_token') || '', user: null as CurrentUser | null }),
  getters: {
    isLoggedIn: (s) => !!s.token,
    canSeeCost: (s) => !!s.user?.can_see_cost,
    canExport: (s) => !!s.user?.can_export,
    canSeeContact: (s) => !!s.user?.can_see_contact,
    roleKey: (s) => s.user?.role_key ?? '',
    menus: (s) => s.user?.menu_perms ?? [],
  },
  actions: {
    /**
     * 只有该菜单在权限内才发这个请求。
     * 没权限的下拉本来就是空的：撞一个 403 回来既进控制台噪声，又让「没数据」和「没权限」长得一模一样。
     */
    async fetchScoped<T>(menu: string, url: ApiPath, params?: unknown): Promise<T | null> {
      if (!this.menus.includes(menu as never) && this.user?.role_key !== 'boss') return null;
      try {
        return await apiGet<T>(url, params);
      } catch {
        return null;
      }
    },
    async login(username: string, password: string) {
      const r = await apiPost<LoginResp>('/auth/login', { username, password });
      this.token = r.token;
      this.user = r.user;
      localStorage.setItem('tk_token', r.token);
    },
    async me() {
      if (!this.user && this.token) this.user = await apiGet<CurrentUser>('/auth/me');
      return this.user;
    },
    logout() {
      this.token = '';
      this.user = null;
      localStorage.removeItem('tk_token');
    },
  },
});
