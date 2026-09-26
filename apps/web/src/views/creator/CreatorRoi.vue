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
        投产比 = <b>应收返点</b> ÷（寄样运费 + 坑位费 + 达人佣金），全部人民币口径；分母为 0 显示「—」且不参与榜首。
        分子是我们自己的收入，不是带货 GMV —— 带货 GMV 是品牌的生意规模，只看它会把一个亏钱的达人排到第一。
        净带货 GMV 已扣除已完成退款、排除样品单（PRD §5.3 / §5.7）；样品货值由品牌承担，不再进我们的投入。
      </div>
      <el-alert v-if="!auth.canSeeCost" type="warning" show-icon :closable="false" class="page-tip"
        title="当前账号无「金额权限」（原可见成本）：以下金额与投产比由后端返回 ***，页面可打开但不可用于对账。" />
      <el-alert v-else-if="!hasRebateCol" type="warning" show-icon :closable="false" class="page-tip"
        title="这个维度接口没有下发「应收返点」列，合计投产比一律显示「—」（宁可不给数，也不会拿带货 GMV 冒充我们的收入）。" />
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
          <el-empty description="所选期间没有可归因到达人的成交：订单行没挂 creator_id，或期间/站点筛得太窄">
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
import { COLLAB_STATUS, MASK, collabRoi, num, round2 } from '@tk/shared';
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
  { prop: 'gmv_cny', label: '带货GMV(参考)', kind: 'money', width: 135 },
  { prop: 'refund_cny', label: '退款(CNY)', kind: 'money', width: 120 },
  { prop: 'net_gmv_cny', label: '净带货GMV(参考)', kind: 'money', minWidth: 150 },
  { prop: 'rebate_cny', label: '应收返点(CNY)·我们的收入', kind: 'money', width: 190 },
  { prop: 'sample_shipping', label: '寄样运费(CNY)', kind: 'money', width: 130 },
  { prop: 'fixed_fee_cny', label: '坑位费(CNY)', kind: 'money', width: 125 },
  { prop: 'commission_cny', label: '达人佣金(CNY)', kind: 'money', width: 130 },
  { prop: 'cost', label: '投入合计(CNY)', kind: 'money', width: 135 },
  { prop: 'roi', label: '投产比(返点÷投入)', kind: 'roi', width: 150 },
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
  { prop: 'net_gmv_cny', label: '净带货GMV(参考)', kind: 'money', minWidth: 150 },
  { prop: 'rebate_cny', label: '应收返点(CNY)·我们的收入', kind: 'money', width: 190 },
  { prop: 'cost_cny', label: '投入合计(CNY)', kind: 'money', width: 135 },
  { prop: 'roi', label: '投产比(返点÷投入)', kind: 'roi', width: 150 },
];

const COLLAB_COLS: Col[] = [
  { prop: 'collab_no', label: '合作单号', kind: 'text', width: 150, align: 'left', sortable: false },
  { prop: 'handle', label: '达人', kind: 'text', width: 170, align: 'left', sortable: false },
  { prop: 'coop_type', label: '合作方式', kind: 'text', width: 100, align: 'center', sortable: false },
  { prop: 'status', label: '状态', kind: 'text', width: 80, align: 'center', sortable: false },
  { prop: 'published_videos', label: '发布视频', kind: 'int', width: 95 },
  { prop: 'orders', label: '带货订单数', kind: 'int', width: 110 },
  { prop: 'net_gmv_cny', label: '净带货GMV(参考)', kind: 'money', minWidth: 150 },
  { prop: 'rebate_cny', label: '应收返点(CNY)·我们的收入', kind: 'money', width: 190 },
  { prop: 'sample_shipping', label: '寄样运费(CNY)', kind: 'money', width: 130 },
  { prop: 'fixed_fee_cny', label: '坑位费(CNY)', kind: 'money', width: 125 },
  { prop: 'commission_cny', label: '达人佣金(CNY)', kind: 'money', width: 130 },
  { prop: 'cost', label: '投入合计(CNY)', kind: 'money', width: 135 },
  { prop: 'roi', label: '投产比(返点÷投入)', kind: 'roi', width: 150 },
];

const cols = computed<Col[]>(() => (dim.value === 'bd' ? BD_COLS : dim.value === 'collab' ? COLLAB_COLS : CREATOR_COLS));

/* ---------- 渲染（后端无权限时值为 ***，直接展示） ---------- */
/** 这个维度到底有没有「应收返点」这一列：没有就不给合计投产比，绝不拿带货 GMV 凑分子 */
const hasRebateCol = computed(() => rows.value.some((r) => r.rebate_cny !== undefined && r.rebate_cny !== null));

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

function onSortChange({ prop, order }: { prop: string | null; order: string | null; column?: unknown }) {
  const list = [...rows.value];
  if (!order || !prop) {
    rows.value = list;
    return;
  }
  const dir = order === 'ascending' ? 1 : -1;
  rows.value = list.sort((a, b) => (sortValue(a, prop) - sortValue(b, prop)) * dir);
}

/* ---------- 合计行（投产比用合计值重算，不做平均） ---------- */
function sumOf(prop: string): number | string {
  if (rows.value.some((r) => r[prop] === MASK)) return MASK;
  return round2(rows.value.reduce((s, r) => s + num(r[prop]), 0));
}
/** 掩码就照掩码传，数字就照数字传；非数字（列不存在）返回 null 让上层显示「—」 */
function numOf(prop: string): number | null {
  const s = sumOf(prop);
  if (s === MASK) return Number.NaN;
  return Number(s);
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
      sums.push(dim.value === 'bd' ? roiOfBdTotal() : roiOfTotal());
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
/** 达人 / 合作单维度：分子＝应收返点，分母＝寄样运费 + 坑位费 + 达人佣金（与 @tk/shared 的 collabRoi 同一公式） */
function roiOfTotal(): string {
  if (!hasRebateCol.value) return '—';
  const rebate = numOf('rebate_cny');
  if (rebate === null) return '—';
  if (Number.isNaN(rebate)) return MASK;
  const roi = collabRoi({
    rebate_cny: rebate,
    sample_shipping: numOf('sample_shipping') ?? 0,
    fixed_fee_cny: numOf('fixed_fee_cny') ?? 0,
    commission_cny: numOf('commission_cny') ?? 0,
  });
  return roi === null ? '—' : roi.toFixed(2);
}
/** BD 维度接口只给到投入合计（寄样运费 + 坑位 + 佣金已并成一个数），返点列没下发时同样给「—」 */
function roiOfBdTotal(): string {
  if (!hasRebateCol.value) return '—';
  const rebate = numOf('rebate_cny');
  const cost = numOf('cost_cny');
  if (rebate === null || cost === null) return '—';
  if (Number.isNaN(rebate) || Number.isNaN(cost)) return MASK;
  const roi = collabRoi({ rebate_cny: rebate, sample_shipping: 0, fixed_fee_cny: cost, commission_cny: 0 });
  return roi === null ? '—' : roi.toFixed(2);
}

/* ---------- 取数：/creators/roi/rank?dim=&period=&region=&limit= ---------- */
const COOP_LABEL: Record<number, string> = { 1: '纯佣金', 2: '坑位费+佣金', 3: '付费视频', 4: '直播专场' };
const COLLAB_LABEL: Record<number, string> = {
  [COLLAB_STATUS.AGREED]: '已谈妥',
  [COLLAB_STATUS.TO_SHIP]: '待寄样',
  [COLLAB_STATUS.IN_TRANSIT]: '样品在途',
  [COLLAB_STATUS.TO_PUBLISH]: '待发布',
  [COLLAB_STATUS.PUBLISHED]: '已发布',
  [COLLAB_STATUS.FINISHED]: '已完结',
  [COLLAB_STATUS.OVERDUE]: '超期未履约',
  [COLLAB_STATUS.CANCELLED]: '已取消',
};

async function load() {
  loading.value = true;
  try {
    const data = await apiGet<Row | Row[]>('/creators/roi/rank', {
      dim: dim.value,
      limit: limit.value,
      ...(range.value?.[0] && range.value?.[1] ? { period: `${range.value[0]}~${range.value[1]}` } : {}),
      ...(region.value ? { region: region.value } : {}),
    });
    const list = Array.isArray(data) ? data : ((data?.list as Row[] | undefined) ?? []);
    // 应收返点：宽表口径叫 rebate、榜单口径叫 rebate_cny，两个都认（认不出就是没下发，合计投产比会显示「—」）
    const withRebate: Row[] = list.map((r) => ({ ...r, rebate_cny: r.rebate_cny ?? r.rebate }));
    // 合作单维度后端回数字枚举，这里换成中文，否则表格里是一列 1/2/3
    rows.value = dim.value === 'collab'
      ? withRebate.map((r) => ({ ...r, coop_type: COOP_LABEL[num(r.coop_type)] ?? String(r.coop_type ?? ''), status: COLLAB_LABEL[num(r.status)] ?? String(r.status ?? '') }))
      : withRebate;
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
