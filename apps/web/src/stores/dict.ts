import { defineStore } from 'pinia';
import { apiGet } from '@/api/client';

export interface DictOption {
  dict_value: string;
  dict_label: string;
}

/** 数据字典缓存：下拉选项集中维护，加选项不改程序（方案表 26） */
export const useDictStore = defineStore('dict', {
  state: () => ({
    cache: {} as Record<string, DictOption[]>,
    shops: [] as { id: number; shop_name: string; region: string; currency: string }[],
  }),
  actions: {
    async dict(type: string): Promise<DictOption[]> {
      if (this.cache[type]) return this.cache[type];
      try {
        const rows = await apiGet<DictOption[]>(`/system/dict/${type}`);
        this.cache[type] = rows;
        return rows;
      } catch {
        return [];
      }
    },
    async shopOptions() {
      if (!this.shops.length) this.shops = await apiGet('/shops/mine');
      return this.shops;
    },
    shopLabel(id: number) {
      return this.shops.find((s) => s.id === id)?.shop_name ?? String(id);
    },
  },
});
