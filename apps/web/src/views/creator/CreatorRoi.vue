<template>
  <div class="page">
    <el-card class="page-card" shadow="never">
      <div class="filter-bar">
        <el-radio-group v-model="dim" @change="() => load()">
          <el-radio-button value="creator">按达人</el-radio-button>
          <el-radio-button value="bd">按 BD</el-radio-button>
          <el-radio-button value="collab">按合作单</el-radio-button>
        </el-radio-group>
        <el-date-picker
          v-model="range"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          clearable
          style="width: 240px"
        />
        <el-select v-model="region" clearable placeholder="全部站点" style="width: 130px">
          <el-option v-for="o in regionOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-select v-model="limit" style="width: 120px">
          <el-option v-for="n in [20, 50, 100, 200]" :key="n" :label="`Top ${n}`" :value="n" />
        </el-select>
        <el-button type="primary" :icon="Search" :loading="loading" @click="load">查询</el-button>
        <el-button :icon="RefreshLeft" @click="reset">重置</el-button>
      </div>
      <div class="tip">
        ROI = 带货净 GMV ÷（样品成本 + 寄样运费 + 坑位费 + 达人佣金），全部人民币口径；分母为 0 显示「—」且不参与榜首。
        净 GMV 已扣除已完成退款、排除样品单（PRD §5.3 / §5.7）。
      </div>
      <el-alert v-if="!auth.canSeeCost" type="warning" show-icon :closable="false" class="page-tip"
        title="当前账号无「成本权限」：以下金额与 ROI 由后端返回 ***，页面可打开但不可用于对账。" />
    </el-card>

    <el-card shadow="never">
      <el-table
        v-loading="loading"
        :data="rows"
        border
        stripe
        size="small"
        show-summary
        :summary-method="summary"
        :default-sort="{ prop: 'roi', order: 'descending' }"
        style="width: 100%"
        @sort-change="onSortChange"
      >
        <el-table-column type="index" label="排名" width="60" fixed="left" />
        <el-table-column v-for="c in cols" :key="c.prop" :prop="c.prop" :label="c.label" :width="c.width" :min-width="c.minWidth" :align="c.align ?? 'right'" :sortable="c.sortable === false ? false : 'custom'" show-overflow-tooltip>
          <template #default="{ row }">
            <span :class="{ 'money-cny': c.kind === 'money', mask: row[c.prop] === MASK }">{{ render(row, c) }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="所选期间没有可归因的达人带货数据">
            <el-button type="primary" @click="router.push('/creators/collab')">先去登记合作单</el-button>
          </el-empty>
        </template>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { RefreshLeft, Search } from '@element-plus/icons-vue';
import { MASK, collabRoi, num, round2 } from '@tk/shared';
import { apiGet, errMsg } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useDictStore } from '@/stores/dict';

type Row = Record<string, unknown>;
type Kind = 'text' | 'money' | 'int' | 'roi' | 'pct';

interface Col {
  prop: string;
  label: string;
  kind: Kind;
  width?: number;
  minWidth?: number;
  align?: 'left' | 'center' | 'right';
  sortable?: boolean;
}

const router = useRouter();
const auth = useAuthStore();
const dict = useDictStore();

const loading = ref(false);
const rows = ref<Row[]>([]);
const dim = ref<'creator' | 'bd' | 'collab'>('creator');
const range = ref<[string, string] | null>(null);
const region = ref<string>('');
const limit = ref(50);

const regionOptions = computed(() => (dict.cache.region ?? []).map((d) => ({ value: d.dict_value, label: d.dict_label })));

const CREATOR_COLS: Col[] = [
  { prop: 'handle', label: '达人 handle', kind: 'text', width: 170, align: 'left', sortable: false },
  { prop: 'nickname', label: '昵称', kind: 'text', width: 140, align: 'left', sortable: false },
  { prop: 'region', label: '站点', kind: 'text', width: 70, align: 'center', sortable: false },
  { prop: 'owner_name', label: '归属 BD', kind: 'text', width: 110, align: 'left', sortable: false },
  { prop: 'collabs', label: '合作单数', kind: 'int', width: 95 },
  { prop: 'published_videos', label: '发布视频', kind: 'int', width: 95 },
  { prop: 'orders', label: '带货订单数', kind: 'int', width: 110 },
  { prop: 'gmv_cny', label: 'GMV(CNY)', kind: 'money', width: 130 },
  { prop: 'refund_cny', label: '退款(CNY)', kind: 'money', width: 120 },
  { prop: 'net_gmv_cny', label: '净GMV(CNY)', kind: 'money', minWidth: 130 },
  { prop: 'sample_cost', label: '样品成本(CNY)', kind: 'money', width: 130 },
  { prop: 'sample_shipping', label: '寄样运费(CNY)', kind: 'money', width: 130 },
  { prop: 'fixed_fee_cny', label: '坑位费(CNY)', kind: 'money', width: 125 },
  { prop: 'commission_cny', label: '达人佣金(CNY)', kind: 'money', width: 130 },
  { prop: 'cost', label: '投入合计(CNY)', kind: 'money', width: 135 },
  { prop: 'roi', label: 'ROI', kind: 'roi', width: 90 },
];

const BD_COLS: Col[] = [
  { prop: 'real_name', label: 'BD', kind: 'text', width: 130, align: 'left', sortable: false },
  { prop: 'dept', label: '部门', kind: 'text', width: 130, align: 'left', sortable: false },
  { prop: 'outreach_cnt', label: '建联数', kind: 'int', width: 100 },
  { prop: 'replied_cnt', label: '回复数', kind: 'int', width: 100 },
  { prop: 'reply_rate', label: '回复率', kind: 'pct', width: 100 },
  { prop: 'agreed_cnt', label: '谈妥数', kind: 'int', width: 100 },
  { prop: 'collab_cnt', label: '合作单数', kind: 'int', width: 105 },
  { prop: 'creator_cnt', label: '触达达人数', kind: 'int', width: 115 },
  { prop: 'net_gmv_cny', label: '净GMV(CNY)', kind: 'money', minWidth: 135 },
  { prop: 'cost_cny', label: '投入合计(CNY)', kind: 'money', width: 135 },
  { prop: 'roi', label: 'ROI', kind: 'roi', width: 90 },
];

const COLLAB_COLS: Col[] = [
  { prop: 'collab_no', label: '合作单号', kind: 'text', width: 150, align: 'left', sortable: false },
  { prop: 'handle', label: '达人', kind: 'text', width: 170, align: 'left', sortable: false },
  { prop: 'coop_type', label: '合作方式', kind: 'text', width: 100, align: 'center', sortable: false },
  { prop: 'status', label: '状态', kind: 'text', width: 80, align: 'center', sortable: false },
  { prop: 'published_videos', label: '发布视频', kind: 'int', width: 95 },
  { prop: 'orders', label: '带货订单数', kind: 'int', width: 110 },
  { prop: 'net_gmv_cny', label: '净GMV(CNY)', kind: 'money', minWidth: 130 },
  { prop: 'sample_cost', label: '样品成本(CNY)', kind: 'money', width: 130 },
  { prop: 'sample_shipping', label: '寄样运费(CNY)', kind: 'money', width: 130 },
  { prop: 'fixed_fee_cny', label: '坑位费(CNY)', kind: 'money', width: 125 },
  { prop: 'commission_cny', label: '达人佣金(CNY)', kind: 'money', width: 130 },
  { prop: 'cost', label: '投入合计(CNY)', kind: 'money', width: 135 },
  { prop: 'roi', label: 'ROI', kind: 'roi', width: 90 },
];

const cols = computed<Col[]>(() => (dim.value === 'bd' ? BD_COLS : dim.value === 'collab' ? COLLAB_COLS : CREATOR_COLS));

/* ---------- 渲染（后端无权限时值为 ***，直接展示） ---------- */
function render(row: Row, c: Col): string {
  const v = row[c.prop];
  if (v === MASK) return MASK;
  if (v === null || v === undefined || v === '') return c.kind === 'roi' ? '—' : '-';
  if (c.kind === 'money') return num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (c.kind === 'int') return Math.round(num(v)).toLocaleString('zh-CN');
  if (c.kind === 'pct') return `${num(v).toFixed(1)}%`;
  if (c.kind === 'roi') return num(v).toFixed(2);
  return String(v);
}

/** 表头点击排序：本地比较，null（—）/ *** 不参与榜首 */
const sortValue = (row: Row, prop: string) => (row[prop] === MASK || row[prop] === null || row[prop] === undefined ? Number.NEGATIVE_INFINITY : num(row[prop]));

function onSortChange({ prop, order }: { prop: string; order: 'ascending' | 'descending' | null }) {
  const list = [...rows.value];
  if (!order || !prop) {
    rows.value = list;
    return;
  }
  const dir = order === 'ascending' ? 1 : -1;
  rows.value = list.sort((a, b) => (sortValue(a, prop) - sortValue(b, prop)) * dir);
}

/* ---------- 合计行（ROI 用合计值重算，不做平均） ---------- */
function sumOf(prop: string): number | string {
  if (rows.value.some((r) => r[prop] === MASK)) return MASK;
  return round2(rows.value.reduce((s, r) => s + num(r[prop]), 0));
}
function summary({ columns }: { columns: { property?: string }[] }) {
  const sums: string[] = [];
  columns.forEach((col, idx) => {
    if (idx === 0) {
      sums.push('本页合计');
      return;
    }
    const prop = col.property ?? '';
    const c = cols.value.find((x) => x.prop === prop);
    if (!c) {
      sums.push('');
      return;
    }
    if (c.kind === 'roi') {
      const roi = collabRoi({
        net_gmv_cny: Number(sumOf('net_gmv_cny')) || 0,
        sample_cost: Number(sumOf('sample_cost')) || 0,
        sample_shipping: Number(sumOf('sample_shipping')) || 0,
        fixed_fee_cny: Number(sumOf('fixed_fee_cny')) || 0,
        commission_cny: Number(sumOf('commission_cny')) || 0,
      });
      sums.push(dim.value === 'bd' ? roiOfBdTotal() : roi === null ? '—' : roi.toFixed(2));
      return;
    }
    if (c.kind === 'text') {
      sums.push('');
      return;
    }
    const s = sumOf(prop);
    sums.push(s === MASK ? MASK : c.kind === 'int' ? Math.round(Number(s)).toLocaleString('zh-CN') : Number(s).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  });
  return sums;
}
function roiOfBdTotal(): string {
  const net = Number(sumOf('net_gmv_cny')) || 0;
  const cost = Number(sumOf('cost_cny')) || 0;
  const roi = collabRoi({ net_gmv_cny: net, sample_cost: 0, sample_shipping: 0, fixed_fee_cny: cost, commission_cny: 0 });
  return roi === null ? '—' : roi.toFixed(2);
}

/* ---------- 取数：/creators/roi?dim=&from=&to=&region=&limit= ---------- */
async function load() {
  loading.value = true;
  try {
    const data = await apiGet<Row | Row[]>('/creators/roi', {
      dim: dim.value,
      limit: limit.value,
      ...(range.value?.[0] ? { from: range.value[0] } : {}),
      ...(range.value?.[1] ? { to: range.value[1] } : {}),
      ...(region.value ? { region: region.value } : {}),
    });
    const list = Array.isArray(data) ? data : ((data?.list as Row[] | undefined) ?? []);
    rows.value = list;
  } catch (e) {
    rows.value = [];
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

function reset() {
  dim.value = 'creator';
  range.value = null;
  region.value = '';
  limit.value = 50;
  void load();
}

onMounted(async () => {
  void dict.dict('region').catch(() => undefined);
  await load();
});
</script>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.tip {
  color: #909399;
  font-size: 12px;
  line-height: 1.6;
}
.page-tip {
  margin-top: 10px;
}
.mask {
  color: #909399;
}
</style>
