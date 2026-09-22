import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { apiGet, errMsg } from '@/api/client';

export interface DictOption {
  dict_value: string;
  dict_label: string;
}

/**
 * 同一种失败只说一次。
 * 一页可能有五个下拉都读字典，接口挂一次就弹五条会把人逼疯；
 * 但「一声不响返回空数组」更糟 —— 界面显示「暂无数据」，
 * 用户和排障的人都分不出是真没有还是没通（本轮就是被 /system/dict 这样骗过去的）。
 */
const warned = new Set<string>();
function shout(what: string, e: unknown): void {
  if (warned.has(what)) return;
  warned.add(what);
  ElMessage.warning(`${what}加载失败：${errMsg(e)}。这是接口问题，不是没有数据。`);
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
      } catch (e) {
        shout(`字典「${type}」`, e);
        return [];
      }
    },
    async shopOptions() {
      try {
        if (!this.shops.length) this.shops = await apiGet('/shops/mine');
      } catch (e) {
        shout('店铺列表', e);
      }
      return this.shops;
    },
    shopLabel(id: number) {
      return this.shops.find((s) => s.id === id)?.shop_name ?? String(id);
    },
  },
});
