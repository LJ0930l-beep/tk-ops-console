<template>
  <div class="page" v-loading="loading">
    <!-- 订单头信息卡片 -->
    <el-card class="page-card" shadow="never">
      <div class="head-bar">
        <div class="head-title">
          <el-button :icon="ArrowLeft" size="small" @click="router.push('/orders')">返回订单列表</el-button>
          <h3>{{ order?.shop_name ?? '订单' }} · {{ order?.tk_order_id ?? orderId }}</h3>
          <el-tag v-if="order" :type="statusTagType" size="small">{{ (ORDER_STATUS_LABEL[status] ?? status) || '—' }}</el-tag>
          <el-tag v-if="isSample" type="info" size="small" effect="dark">样品单 · 不计 GMV</el-tag>
          <el-tag v-if="excludedRows > 0" type="warning" size="small" effect="dark">{{ excludedRows }} 行未配返点率 · 不计利润</el-tag>
        </div>
        <el-button :icon="Refresh" size="small" @click="loadAll">刷新</el-button>
      </div>

      <el-descriptions :column="4" border size="small" class="head-desc">
        <el-descriptions-item label="订单号">{{ text(order?.tk_order_id) }}</el-descriptions-item>
        <el-descriptions-item label="店铺">{{ text(order?.shop_name) }}</el-descriptions-item>
        <el-descriptions-item label="站点/买家地区">{{ text(order?.buyer_region ?? order?.region) }}</el-descriptions-item>
        <el-descriptions-item label="币种">{{ text(order?.currency) }}</el-descriptions-item>
        <el-descriptions-item label="下单时间">{{ dateTime(order?.order_time) }}</el-descriptions-item>
        <el-descriptions-item label="支付时间">{{ dateTime(order?.paid_time) }}</el-descriptions-item>
        <el-descriptions-item label="发货时间">{{ dateTime(order?.ship_time) }}</el-descriptions-item>
        <el-descriptions-item label="同步时间">{{ dateTime(order?.synced_at) }}</el-descriptions-item>
        <el-descriptions-item label="商品小计">{{ money(order?.subtotal) }}</el-descriptions-item>
        <el-descriptions-item label="卖家优惠">{{ money(order?.seller_discount) }}</el-descriptions-item>
        <el-descriptions-item label="平台优惠">{{ money(order?.platform_discount) }}</el-descriptions-item>
        <el-descriptions-item label="运费">{{ money(order?.shipping_fee) }}</el-descriptions-item>
        <el-descriptions-item label="买家实付">
          <b>{{ money(order?.total_paid) }} {{ text(order?.currency) }}</b>
        </el-descriptions-item>
        <el-descriptions-item label="实付折算(CNY)">{{ money(order?.total_paid_cny ?? order?.paid_amount_cny) }}</el-descriptions-item>
        <el-descriptions-item label="履约方式">{{ fulfillmentLabel }}</el-descriptions-item>
        <el-descriptions-item label="承运/运单">{{ [order?.carrier, order?.tracking_no].filter(Boolean).join(' / ') || '-' }}</el-descriptions-item>
        <el-descriptions-item label="明细行数">{{ text(order?.item_count ?? items.length) }}</el-descriptions-item>
        <el-descriptions-item label="商品金额合计">{{ money(itemsAmount) }}</el-descriptions-item>
        <el-descriptions-item :label="secLabel('应收返点(CNY)')">{{ maskedOr(order?.rebate_cny, () => itemsRebateSum) }}</el-descriptions-item>
        <el-descriptions-item :label="secLabel('物流支出(CNY)')">{{ maskedOr(order?.logistics_cny, () => itemsLogisticsSum) }}</el-descriptions-item>
        <el-descriptions-item :label="secLabel('预估贡献毛利(CNY)')">{{ maskedOr(order?.est_profit_cny ?? order?.est_profit, () => itemsProfitSum) }}</el-descriptions-item>
        <el-descriptions-item label="不计利润的行">{{ excludedRows }} / {{ items.length }}</el-descriptions-item>
      </el-descriptions>
      <div v-if="!auth.canSeeCost" class="mask-tip">
        <el-icon><Lock /></el-icon> 返点与利润字段需「金额权限」（原可见成本），当前账号由后端返回 ***（列不隐藏，便于对账）。
      </div>
    </el-card>

    <!-- 明细表格 -->
    <el-card shadow="never" class="page-card">
      <template #header><b>订单明细</b><span class="sub">没配到品牌返点率的行整体排除：不按 0 返点、也不按 0 收入计利润（PRD §5.6）</span></template>
      <el-table :data="items" border stripe size="small" :row-class-name="itemRowClass" style="width: 100%" v-loading="itemsLoading">
        <el-table-column type="index" label="#" width="46" />
        <el-table-column prop="sku_code" label="内部 SKU" width="140">
          <template #default="{ row }">{{ row.sku_code || '—' }}</template>
        </el-table-column>
        <el-table-column prop="listing_name" label="平台商品" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.listing_name ?? row.product_name ?? '-' }}</template>
        </el-table-column>
        <el-table-column prop="tk_sku_id" label="tk_sku_id" width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.tk_sku_id ?? '-' }}</template>
        </el-table-column>
        <el-table-column prop="quantity" label="数量" width="70" align="right" />
        <el-table-column prop="unit_price" label="单价" width="95" align="right">
          <template #default="{ row }">{{ money(row.unit_price) }}</template>
        </el-table-column>
        <el-table-column prop="discount" label="优惠" width="95" align="right">
          <template #default="{ row }">{{ money(row.discount) }}</template>
        </el-table-column>
        <el-table-column prop="item_amount" label="行金额" width="110" align="right">
          <template #default="{ row }"><b>{{ money(row.item_amount) }}</b></template>
        </el-table-column>
        <el-table-column prop="item_amount_cny" label="折算(CNY)" width="110" align="right">
          <template #default="{ row }">{{ money(row.item_amount_cny ?? row.item_amount_cny_est) }}</template>
        </el-table-column>
        <el-table-column prop="rebate_rate" :label="secLabel('返点率')" width="90" align="right">
          <template #default="{ row }">{{ fracPct(row.rebate_rate) }}</template>
        </el-table-column>
        <el-table-column prop="rebate_cny" :label="secLabel('应收返点(CNY)')" width="130" align="right">
          <template #default="{ row }">{{ excludedRow(row) ? notCounted(row.rebate_cny) : money(row.rebate_cny) }}</template>
        </el-table-column>
        <el-table-column prop="logistics_cny" :label="secLabel('物流支出(CNY)')" width="125" align="right">
          <template #default="{ row }">{{ excludedRow(row) ? notCounted(row.logistics_cny) : money(row.logistics_cny) }}</template>
        </el-table-column>
        <el-table-column label="返点状态" width="170">
          <template #default="{ row }">
            <el-tag v-if="excludedRow(row)" type="danger" size="small">未配返点率 · 不计利润</el-tag>
            <el-tag v-else type="success" size="small">已按冻结返点计入</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="commission_rate" label="佣金率" width="90" align="right">
          <template #default="{ row }">{{ pointsPct(row.commission_rate) }}</template>
        </el-table-column>
        <el-table-column prop="est_commission" :label="secLabel('预估佣金')" width="110" align="right">
          <template #default="{ row }">{{ money(row.est_commission) }}</template>
        </el-table-column>
        <el-table-column :label="secLabel('预估贡献毛利(CNY)')" width="150" align="right">
          <template #default="{ row }">{{ itemProfit(row) }}</template>
        </el-table-column>
        <el-table-column prop="creator_handle" label="带货达人" width="140">
          <template #default="{ row }">{{ row.creator_handle || '—' }}</template>
        </el-table-column>
        <el-table-column prop="content_type" label="内容来源" width="110">
          <template #default="{ row }">{{ contentTypeLabel(row.content_type) }}</template>
        </el-table-column>
        <el-table-column prop="content_id" label="内容 ID" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.content_id ?? '-' }}</template>
        </el-table-column>
        <template #empty>
          <el-empty description="没有订单明细：订单同步没带回明细，或店铺商品还没映射到内部 SKU">
            <el-button type="primary" @click="router.push('/products/unmapped')">去处理未配返点的行</el-button>
          </el-empty>
        </template>
      </el-table>
    </el-card>

    <!-- 售后列表 -->
    <el-card shadow="never">
      <template #header><b>售后记录</b><span class="sub">已完成退款冲减净 GMV；处理中不冲减（PRD §4.2 场景 D）</span></template>
      <el-table :data="returns" border stripe size="small" :row-class-name="returnRowClass" style="width: 100%" v-loading="returnsLoading">
        <el-table-column type="index" label="#" width="46" />
        <el-table-column prop="tk_return_id" label="售后单号" width="180" />
        <el-table-column prop="return_type" label="类型" width="110">
          <template #default="{ row }">{{ RETURN_TYPE[row.return_type] ?? '-' }}</template>
        </el-table-column>
        <el-table-column prop="reason" label="退款原因" min-width="180" show-overflow-tooltip />
        <el-table-column prop="refund_amount" label="退款金额" width="120" align="right">
          <template #default="{ row }">{{ money(row.refund_amount) }} {{ row.currency ?? '' }}</template>
        </el-table-column>
        <el-table-column prop="status" label="平台状态" width="130" />
        <el-table-column prop="apply_time" label="申请时间" width="150">
          <template #default="{ row }">{{ dateTime(row.apply_time) }}</template>
        </el-table-column>
        <el-table-column prop="finish_time" label="完成时间" width="150">
          <template #default="{ row }">{{ dateTime(row.finish_time) }}</template>
        </el-table-column>
        <el-table-column prop="responsibility" label="责任归属" width="110">
          <template #default="{ row }">
            <el-tag :type="Number(row.responsibility) === 0 ? 'warning' : 'info'" size="small">
              {{ RESPONSIBILITY_LABEL[String(row.responsibility ?? 0)] ?? '-' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="is_restocked" label="是否回库" width="100">
          <template #default="{ row }">{{ Number(row.is_restocked) === 1 ? '已回库' : '未回库' }}</template>
        </el-table-column>
        <template #empty>
          <el-empty description="该订单暂无售后退款记录" />
        </template>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowLeft, Lock, Refresh } from '@element-plus/icons-vue';
import { CONTENT_TYPE, MASK, ORDER_STATUS_LABEL, estItemProfitCny, num, round2 } from '@tk/shared';
import { apiGet, errMsg } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

type Row = Record<string, unknown>;

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const loading = ref(false);
const itemsLoading = ref(false);
const returnsLoading = ref(false);
const order = ref<Row | null>(null);
const items = ref<Row[]>([]);
const returns = ref<Row[]>([]);

const orderId = computed(() => String(route.params.id ?? ''));

const RETURN_TYPE: Record<string, string> = { 1: '仅退款', 2: '退货退款' };
const RESPONSIBILITY_LABEL: Record<string, string> = { 0: '未归类', 1: '质量', 2: '物流', 3: '描述不符', 4: '买家原因' };
const CONTENT_TYPE_LABEL: Record<string, string> = {
  [CONTENT_TYPE.CREATOR_VIDEO]: '达人视频',
  [CONTENT_TYPE.CREATOR_LIVE]: '达人直播',
  [CONTENT_TYPE.OWN_VIDEO]: '自营视频',
  [CONTENT_TYPE.OWN_LIVE]: '自营直播',
  [CONTENT_TYPE.PRODUCT_CARD]: '商品卡',
};
const FULFILLMENT_LABEL: Record<string, string> = { 1: '平台仓', 2: '自发货', 3: '海外仓' };
const STATUS_TYPE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'primary'> = {
  UNPAID: 'warning', ON_HOLD: 'warning', ON_HOLD_SUBSTATUS_ESCALATION: 'danger', TO_BE_SHIPPED: 'primary',
  INVOICE_CREATED: 'primary', TRANSIT_TO_SHIP: 'primary', SHIPPED: 'primary', DELIVERED: 'success',
  COMPLETED: 'success', CANCELLED: 'info',
};

const status = computed(() => String(order.value?.order_status ?? ''));
const statusTagType = computed(() => STATUS_TYPE[status.value] ?? 'info');
const isSample = computed(() => Number(order.value?.is_sample_order) === 1);
const fulfillmentLabel = computed(() => FULFILLMENT_LABEL[String(order.value?.fulfillment_type ?? '')] ?? '-');

/* ---------- 展示格式化（后端已按权限返回 ***，前端不隐藏列） ---------- */
const isMask = (v: unknown) => v === MASK;
function money(v: unknown): string {
  if (isMask(v)) return MASK;
  if (v === null || v === undefined || v === '') return '-';
  return num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function text(v: unknown): string {
  if (v === null || v === undefined || v === '') return '-';
  return String(v);
}
function dateTime(v: unknown): string {
  if (isMask(v)) return MASK;
  return v ? String(v).replace('T', ' ').slice(0, 16) : '-';
}
function contentTypeLabel(v: unknown): string {
  if (v === null || v === undefined || v === '') return '未归因';
  return CONTENT_TYPE_LABEL[String(v)] ?? `类型${String(v)}`;
}
const secLabel = (label: string) => (auth.canSeeCost ? label : `${label} 🔒`);
/** 头部汇总：后端有值用后端，无值且无成本权限时不给数字 */
function maskedOr(v: unknown, fallback: () => number | string): string {
  if (isMask(v)) return MASK;
  if (v !== null && v !== undefined && v !== '') return money(v);
  if (!auth.canSeeCost) return MASK;
  const f = fallback();
  return typeof f === 'string' ? f : money(f);
}

/* ---- 率与钱分得很清楚：rebate_rate 是率（小数），一律不进合计；
       rebate_cny / logistics_cny 是钱（人民币），才能相加 ---- */
/** 小数率（0.18 → 18.0%） */
function fracPct(v: unknown): string {
  if (isMask(v)) return MASK;
  if (v === null || v === undefined || v === '') return '-';
  return `${round2(num(v) * 100)}%`;
}
/** 已是百分数的率（佣金率存 18 = 18%） */
function pointsPct(v: unknown): string {
  if (isMask(v)) return MASK;
  if (v === null || v === undefined || v === '') return '-';
  return `${num(v).toFixed(1)}%`;
}
/** 被排除的行不给 0：0 会被读成「这单没赚钱」，实际是这一行不参与计算 */
function notCounted(v: unknown): string {
  return isMask(v) ? MASK : '不计';
}

function excludedRow(row: Row): boolean {
  return !row.sku_id || Number(row.rebate_matched ?? 0) !== 1;
}
const excludedRows = computed(() => items.value.filter(excludedRow).length);

const itemsAmount = computed(() => round2(items.value.reduce((s, r) => s + (isMask(r.item_amount) ? 0 : num(r.item_amount)), 0)));
/** 只加冻结下来的钱（rebate_cny / logistics_cny），排除行整行不算 */
const itemsRebateSum = computed(() =>
  auth.canSeeCost ? round2(items.value.filter((r) => !excludedRow(r)).reduce((s, r) => s + num(r.rebate_cny), 0)) : MASK,
);
const itemsLogisticsSum = computed(() =>
  auth.canSeeCost ? round2(items.value.filter((r) => !excludedRow(r)).reduce((s, r) => s + num(r.logistics_cny), 0)) : MASK,
);
const itemsProfitSum = computed(() => {
  if (!auth.canSeeCost) return MASK;
  const sum = items.value.filter((r) => !excludedRow(r)).reduce<number>((s, r) => {
    const p = profitOf(r);
    return typeof p === 'number' ? round2(s + p) : s;
  }, 0);
  return sum;
});

/** 折算汇率：详情接口优先（order.rate_to_cny），否则按 §5.4 不静默按 1 折 */
function rateOf(): number {
  const r = Number(order.value?.rate_to_cny ?? 0);
  return Number.isFinite(r) ? r : 0;
}
function profitOf(row: Row): number | string {
  const raw = row.est_profit ?? row.est_profit_cny ?? row.item_profit;
  if (isMask(raw)) return MASK;
  if (typeof raw === 'number') return raw;
  if (!auth.canSeeCost) return MASK;
  const currency = String(row.currency ?? order.value?.currency ?? 'CNY');
  const rate = rateOf();
  if (currency !== 'CNY' && !(rate > 0)) return 'NO_RATE';
  // 贡献毛利 = 应收返点 − 物流 − 达人佣金（人民币），公式与后端共用 @tk/shared 的 estItemProfitCny
  return estItemProfitCny({
    item_amount: num(row.item_amount),
    currency,
    rebate_rate: num(row.rebate_rate),
    logistics_cny: num(row.logistics_cny),
    est_commission: num(row.est_commission),
    rate_to_cny: rate || 1,
  });
}
function itemProfit(row: Row): string {
  const p = profitOf(row);
  if (p === MASK) return MASK;
  if (p === 'NO_RATE') return '缺汇率';
  if (excludedRow(row)) return '不计利润';
  return typeof p === 'number' ? money(p) : '-';
}

function itemRowClass({ row }: { row: Row }): string {
  return excludedRow(row) ? 'unmapped-row' : '';
}
function returnRowClass({ row }: { row: Row }): string {
  return Number(row.responsibility ?? 0) === 0 ? 'warning-row' : '';
}

/* ---------- 取数：详情一次给全（order/items/returns），也兼容后端只回主体 ---------- */
function pickList(data: Row | null, keys: string[]): Row[] {
  if (!data) return [];
  for (const k of keys) {
    const v = data[k];
    if (Array.isArray(v)) return v as Row[];
  }
  return [];
}

async function loadAll() {
  if (!orderId.value) return;
  loading.value = true;
  itemsLoading.value = true;
  try {
    const data = await apiGet<Row>(`/orders/${orderId.value}`);
    const head = (data?.order as Row | undefined) ?? data ?? {};
    order.value = head;
    items.value = pickList(data, ['items', 'order_items']);
    returns.value = pickList(data, ['returns', 'return_list']);
    if (!returns.value.length) void loadReturns();
  } catch (e) {
    ElMessage.error(errMsg(e));
    order.value = null;
    items.value = [];
  } finally {
    loading.value = false;
    itemsLoading.value = false;
  }
}

/** 售后可能只在 /orders/returns 列表接口里，按订单号回查一次 */
async function loadReturns() {
  const tkOrderId = String(order.value?.tk_order_id ?? '');
  const shopId = order.value?.shop_id;
  if (!tkOrderId) return;
  returnsLoading.value = true;
  try {
    const data = await apiGet<Row>('/orders/returns', {
      page: 1,
      pageSize: 50,
      tk_order_id: tkOrderId,
      ...(shopId ? { shop_id: shopId } : {}),
    });
    returns.value = pickList(data, ['list', 'returns']);
  } catch (e) {
    returns.value = [];
    // 失败必须说一声：静默成空列表，界面就只显示「暂无数据」，
    // 用户和排障的人都分不出是「真没有」还是「接口挂了」（本轮就是这么被 /system/dict 骗过的）
    ElMessage.error(errMsg(e));
  } finally {
    returnsLoading.value = false;
  }
}

onMounted(loadAll);
</script>

<style scoped>
.head-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.head-title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.head-title h3 {
  margin: 0;
  font-size: 16px;
}
.head-desc :deep(.el-descriptions__label) {
  width: 110px;
}
.mask-tip {
  margin-top: 10px;
  color: #909399;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.sub {
  margin-left: 10px;
  color: #909399;
  font-size: 12px;
}
:deep(.unmapped-row td.el-table__cell) {
  background: #fef0f0 !important;
  color: #c45656;
}
:deep(.warning-row td.el-table__cell) {
  background: #fdf6ec !important;
}
</style>
