<template>
  <ResourcePage
    api="/content/videos"
    title="视频"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    :map-row="mapRow"
    :before-submit="beforeSubmit"
    dialog-width="720px"
    :action-width="140"
  >
    <template #toolbar-extra>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="orders / gmv 为系统汇总列（按订单归因回填，只读）；粘贴 video_url 即可录入，tk_video_id 由后端解析并按唯一键查重。"
        style="width: 640px"
      />
    </template>

    <template #actions="{ row }">
      <el-button link type="primary" size="small" @click="openVideo(row)">打开</el-button>
    </template>

    <template #form-extra="{ form }">
      <el-form-item label="链接解析">
        <el-tag :type="parsedId(form.video_url) ? 'success' : 'warning'" size="large">
          {{ parsedId(form.video_url) ? `tk_video_id = ${parsedId(form.video_url)}` : '暂未能从链接解析出视频 ID' }}
        </el-tag>
        <div class="form-tip">支持 /video/&lt;id&gt;、/v/&lt;id&gt;、?item_id=&lt;id&gt; 或 12 位以上纯数字；解析失败后端将返回 400，最终以服务端结果为准。</div>
      </el-form-item>
    </template>
  </ResourcePage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ResourcePage, { type ColumnDef, type FormFieldDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';
import { parseVideoId, round2 } from '@tk/shared';
import { apiGet } from '@/api/client';
import { useDictStore } from '@/stores/dict';

const dict = useDictStore();
const shops = ref<{ id: number; shop_name: string }[]>([]);
const accounts = ref<{ id: number; handle: string }[]>([]);
const creators = ref<{ id: number; handle: string; nickname?: string | null }[]>([]);
const editors = ref<{ id: number; real_name: string }[]>([]);

/** 发布方：1 自有账号 / 2 达人（video.publisher_type） */
const PUBLISHER_TYPE: OptionDef[] = [
  { value: 1, label: '自有账号', type: 'primary' },
  { value: 2, label: '达人', type: 'warning' },
];

const shopOpts = (): OptionDef[] => shops.value.map((s) => ({ value: s.id, label: s.shop_name }));
const accountOpts = (): OptionDef[] => accounts.value.map((a) => ({ value: a.id, label: a.handle }));
const creatorOpts = (): OptionDef[] =>
  creators.value.map((c) => ({ value: c.id, label: `@${c.handle}${c.nickname ? ` (${c.nickname})` : ''}` }));
const editorOpts = (): OptionDef[] => editors.value.map((u) => ({ value: u.id, label: u.real_name }));

const columns: ColumnDef[] = [
  { prop: 'tk_video_id', label: '视频 ID', width: 150 },
  { prop: 'video_url', label: '视频链接', minWidth: 200 },
  { prop: 'publisher_type', label: '发布方', width: 92, type: 'tag', options: PUBLISHER_TYPE },
  { prop: 'account_handle', label: '自有账号', width: 130 },
  { prop: 'creator_handle', label: '达人', width: 130 },
  { prop: 'collab_no', label: '合作单', width: 130 },
  { prop: 'spu_name', label: '带货商品', width: 150 },
  { prop: 'editor_name', label: '剪辑', width: 90 },
  { prop: 'publish_time', label: '发布时间', width: 145, type: 'datetime', sortable: true },
  { prop: 'views', label: '播放', width: 90, sortable: true },
  { prop: 'likes', label: '点赞', width: 80 },
  { prop: 'comments', label: '评论', width: 80 },
  { prop: 'shares', label: '转发', width: 80 },
  { prop: 'orders', label: '带货订单', width: 95, sortable: true },
  { prop: 'gmv', label: '带货 GMV', width: 110, type: 'money', sortable: true },
  { prop: 'gmv_per_1k', label: '千次观看成交额', width: 135, type: 'money' },
];

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '关键字', placeholder: '视频 ID / 链接' },
  { key: 'publisher_type', label: '发布方', type: 'select', options: PUBLISHER_TYPE },
  { key: 'shop_id', label: '店铺', type: 'select', options: shopOpts() },
  { key: 'publish_time', label: '发布时间', type: 'daterange' },
]);

const formFields: FormFieldDef[] = [
  { key: 'video_url', label: '视频链接', required: true, span: 24, placeholder: '粘贴 TikTok 视频链接（≤500 字符）' },
  { key: 'publisher_type', label: '发布方', type: 'select', required: true, options: PUBLISHER_TYPE, default: 1 },
  { key: 'shop_id', label: '所属店铺', type: 'select', options: shopOpts },
  { key: 'account_id', label: '自有账号', type: 'select', options: accountOpts, when: (f) => Number(f.publisher_type) === 1 },
  { key: 'creator_id', label: '达人', type: 'select', options: creatorOpts, when: (f) => Number(f.publisher_type) === 2 },
  { key: 'collab_id', label: '合作单 ID', type: 'number', precision: 0, min: 1, when: (f) => Number(f.publisher_type) === 2 },
  { key: 'spu_id', label: '商品(SPU)', type: 'number', precision: 0, min: 1 },
  { key: 'editor_id', label: '剪辑', type: 'select', options: editorOpts },
  { key: 'publish_time', label: '发布时间', type: 'datetime' },
];

/** 千次观看成交额 = gmv / views × 1000（PRD §3.6 带货排行口径） */
function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const views = Number(row.views ?? 0);
  const gmv = Number(row.gmv ?? 0);
  return { ...row, gmv_per_1k: views > 0 ? round2((gmv / views) * 1000) : 0 };
}

function beforeSubmit(values: Record<string, unknown>): Record<string, unknown> {
  const v = { ...values };
  if (Number(v.publisher_type) === 1) {
    delete v.creator_id;
    delete v.collab_id;
  } else {
    delete v.account_id;
  }
  for (const k of ['publish_time', 'spu_id', 'editor_id', 'shop_id', 'account_id', 'creator_id', 'collab_id']) {
    if (v[k] === '' || v[k] === undefined) delete v[k];
  }
  return v;
}

function parsedId(url: unknown): string | null {
  return parseVideoId(String(url ?? ''));
}

function openVideo(row: Record<string, unknown>): void {
  const url = String(row.video_url ?? '');
  if (url) window.open(/^https?:\/\//i.test(url) ? url : `https://${url}`, '_blank');
}

onMounted(async () => {
  dict
    .shopOptions()
    .then((s) => (shops.value = s.map((x) => ({ id: x.id, shop_name: x.shop_name }))))
    .catch(() => undefined);
  const [acc, cre, usr] = await Promise.allSettled([
    apiGet<{ list: Record<string, unknown>[] }>('/accounts', { page: 1, pageSize: 200 }),
    apiGet<{ list: Record<string, unknown>[] }>('/creators', { page: 1, pageSize: 200 }),
    apiGet<{ list: Record<string, unknown>[] }>('/system/users', { page: 1, pageSize: 200 }),
  ]);
  const pick = (r: PromiseSettledResult<{ list: Record<string, unknown>[] }>): Record<string, unknown>[] =>
    r.status === 'fulfilled' ? (r.value.list ?? []) : [];
  accounts.value = pick(acc) as { id: number; handle: string }[];
  creators.value = pick(cre) as { id: number; handle: string; nickname?: string | null }[];
  editors.value = pick(usr) as { id: number; real_name: string }[];
});
</script>

<style scoped>
.form-tip {
  font-size: 12px;
  color: #909399;
  line-height: 18px;
}
</style>
