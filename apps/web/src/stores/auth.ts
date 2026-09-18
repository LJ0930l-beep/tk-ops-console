import { defineStore } from 'pinia';
import { apiGet, apiPost } from '@/api/client';
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
