<template>
  <div class="page" v-loading="loading">
    <el-alert
      class="page-card"
      type="info"
      :closable="false"
      show-icon
      title="规则引擎只做检测与建议，不会自动执行任何操作（§1 非目标）"
      description="所有阈值、窗口、冷却、优先级均可配置，不得写死。修改规则会版本号 +1 并全程留痕。ABC 分层阈值在「数据字典」dict_type=abc 维护。"
    />

    <el-card class="page-card" shadow="never">
      <template #header>
        <b>预警规则（{{ rules.length }}）</b>
        <span class="head-tip">普通运营可查看命中规则；仅主管/管理员可修改阈值</span>
        <div style="float: right">
          <el-button v-if="canEdit" size="small" :loading="evaluating" @click="runEvaluate">手动跑一轮</el-button>
          <el-button size="small" @click="load">刷新</el-button>
        </div>
      </template>

      <el-table :data="rules" size="small" border stripe row-key="id">
        <el-table-column prop="rule_code" label="规则码" width="180" />
        <el-table-column prop="rule_name" label="名称" min-width="130" show-overflow-tooltip />
        <el-table-column label="对象" width="80">
          <template #default="{ row }"><el-tag size="small" effect="plain">{{ TARGET_LABELS[row.target_type] || row.target_type }}</el-tag></template>
        </el-table-column>
        <el-table-column label="触发条件" min-width="200">
          <template #default="{ row }">
            <code class="cond">{{ row.metric }} {{ row.operator }} {{ row.threshold }}</code>
            <span class="muted"> · 窗口 {{ row.window_days }}d</span>
          </template>
        </el-table-column>
        <el-table-column label="优先级" width="90" align="center">
          <template #default="{ row }"><el-tag size="small" :type="prioType(row.priority)" effect="dark">{{ 'P' + row.priority }}</el-tag></template>
        </el-table-column>
        <el-table-column label="冷却" width="80" align="right">
          <template #default="{ row }">{{ row.cooldown_hours }}h</template>
        </el-table-column>
        <el-table-column label="版本" width="64" align="center" prop="version" />
        <el-table-column label="状态" width="80" align="center">
          <template #default="{ row }">
            <el-switch :model-value="row.status === 1" :disabled="!canEdit" size="small" @change="(v: boolean) => quickToggle(row, v)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button v-if="canEdit" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-tooltip v-else content="需主管/管理员权限" placement="top">
              <el-button link type="info" size="small" disabled>只读</el-button>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="expand">
              <div><b>说明：</b>{{ row.remark || '—' }}</div>
              <div><b>参数(params_json)：</b><code>{{ row.params_json }}</code></div>
              <div><b>作用域(scope_json)：</b><code>{{ row.scope_json }}</code></div>
              <div class="muted">最近更新：{{ row.updated_at }}</div>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="editVisible" :title="`编辑规则 · ${editRow?.rule_code ?? ''}`" width="560px">
      <el-form v-if="editRow" label-width="110px">
        <el-form-item label="名称"><el-input v-model="editRow.rule_name" maxlength="100" /></el-form-item>
        <el-form-item label="触发指标">
          <el-input :model-value="editRow.metric" disabled />
          <span class="muted">指标由引擎实现，不可改；仅阈值/运算符可调</span>
        </el-form-item>
        <el-form-item label="运算符">
          <el-select v-model="editRow.operator" style="width: 120px">
            <el-option v-for="op in ['>', '>=', '<', '<=', '==']" :key="op" :label="op" :value="op" />
          </el-select>
        </el-form-item>
        <el-form-item label="阈值"><el-input-number v-model="editRow.threshold" :step="0.01" :precision="4" controls-position="right" /></el-form-item>
        <el-form-item label="统计窗口(天)"><el-input-number v-model="editRow.window_days" :min="1" :max="365" controls-position="right" /></el-form-item>
        <el-form-item label="优先级">
          <el-radio-group v-model="editRow.priority">
            <el-radio-button :value="0">P0 今日必处理</el-radio-button>
            <el-radio-button :value="1">P1 本周观察</el-radio-button>
            <el-radio-button :value="2">P2 趋势参考</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="冷却(小时)"><el-input-number v-model="editRow.cooldown_hours" :min="1" :max="720" controls-position="right" /></el-form-item>
        <el-form-item label="参数 JSON">
          <el-input v-model="editRow.params_json" type="textarea" :rows="2" />
          <span class="muted">如 {"rising":true} / {"consecutive":2} / {"until_hours":72}</span>
        </el-form-item>
        <el-form-item label="作用域 JSON">
          <el-input v-model="editRow.scope_json" type="textarea" :rows="2" />
          <span class="muted">限定站点/类目/店铺，例如 {"shop_id":1}</span>
        </el-form-item>
        <el-form-item label="说明"><el-input v-model="editRow.remark" maxlength="255" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="editRow.status" :active-value="1" :inactive-value="0" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveRule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { AlertRule } from '@tk/shared';
import { apiGet, apiPost, apiPut, errMsg } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

const TARGET_LABELS: Record<string, string> = { product: '商品', creator: '达人', video: '视频', live: '直播', sample: '寄样', shop: '店铺', ads: '广告' };

const auth = useAuthStore();
const canEdit = computed(() => auth.user?.role_key === 'boss' || !!auth.user?.menu_perms.includes('system' as never));

const loading = ref(false);
const rules = ref<AlertRule[]>([]);
const prioType = (p: number) => (p === 0 ? 'danger' : p === 1 ? 'warning' : 'info') as 'danger' | 'warning' | 'info';

async function load(): Promise<void> {
  loading.value = true;
  try {
    const d = await apiGet<{ list: AlertRule[] }>('/actions/rules');
    rules.value = d.list ?? [];
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

const editVisible = ref(false);
const saving = ref(false);
const editRow = ref<AlertRule | null>(null);
function openEdit(row: AlertRule): void {
  editRow.value = { ...row };
  editVisible.value = true;
}
async function saveRule(): Promise<void> {
  if (!editRow.value) return;
  saving.value = true;
  try {
    const r = editRow.value;
    await apiPut(`/actions/rules/${r.id}`, {
      rule_name: r.rule_name,
      operator: r.operator,
      threshold: r.threshold,
      window_days: r.window_days,
      priority: r.priority,
      cooldown_hours: r.cooldown_hours,
      status: r.status,
      params_json: r.params_json,
      scope_json: r.scope_json,
      remark: r.remark,
    });
    ElMessage.success('规则已更新，版本号 +1');
    editVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

async function quickToggle(row: AlertRule, on: boolean): Promise<void> {
  try {
    await apiPut(`/actions/rules/${row.id}`, { status: on ? 1 : 0 });
    row.status = on ? 1 : 0;
    ElMessage.success(on ? '规则已启用' : '规则已停用');
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

const evaluating = ref(false);
async function runEvaluate(): Promise<void> {
  evaluating.value = true;
  try {
    const d = await apiPost<{ evaluated_rules: number; hits: number; created_events: number; skipped_cooldown: number; errors: string[] }>('/actions/evaluate');
    ElMessage.success(`评估 ${d.evaluated_rules} 条规则，命中 ${d.hits}，新增 ${d.created_events}，冷却跳过 ${d.skipped_cooldown}`);
    if (d.errors?.length) ElMessage.warning(`部分规则失败：${d.errors.join('；').slice(0, 200)}`);
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    evaluating.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.head-tip { color: #909399; font-size: 12px; margin-left: 10px; font-weight: 400; }
.cond { background: #f2f3f5; border-radius: 3px; padding: 1px 6px; font-size: 12px; }
.muted { color: #909399; font-size: 12px; margin-left: 6px; }
.expand { padding: 6px 16px; font-size: 13px; line-height: 1.9; color: #606266; }
.expand code { background: #f2f3f5; border-radius: 3px; padding: 1px 6px; }
</style>
