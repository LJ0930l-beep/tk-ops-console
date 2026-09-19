<template>
  <div class="ev-list">
    <div v-for="e in events" :key="e.id" class="ev-row">
      <div class="ev-main" @click="emit('open', e.id)">
        <div class="ev-title">
          <span class="ev-target">{{ e.target_name || '—' }}</span>
          <el-tag size="small" type="info" effect="plain">{{ e.rule_name }}</el-tag>
          <el-tag v-if="e.status === 1" size="small" type="warning" effect="plain">处理中</el-tag>
        </div>
        <div class="ev-chips">
          <span v-for="(v, k) in chips(e.evidence)" :key="k" class="chip">{{ k }}: {{ v }}</span>
        </div>
      </div>
      <div class="ev-side">
        <span class="ev-due" :class="{ overdue: isOverdue(e) }">{{ dueText(e) }}</span>
        <el-button size="small" type="primary" @click.stop="emit('act', e.id)">处理</el-button>
        <el-button size="small" @click.stop="emit('open', e.id)">详情</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Ev {
  id: number;
  rule_name: string;
  target_name: string | null;
  status: number;
  due_at: string | null;
  detected_at: string;
  evidence: Record<string, unknown>;
}
defineProps<{ events: Ev[] }>();
const emit = defineEmits<{ (e: 'open', id: number): void; (e: 'act', id: number): void }>();

/** 只挑最有信息量的 3 个证据字段做行内摘要 */
function chips(ev: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ev ?? {})) {
    if (k === 'rule' || k === 'window' || v === null || typeof v === 'object') continue;
    out[k] = typeof v === 'number' ? String(Number(v.toFixed(2))) : String(v);
    if (Object.keys(out).length >= 3) break;
  }
  return out;
}

function dueText(e: Ev): string {
  if (!e.due_at) return '';
  const diff = Date.parse(e.due_at.replace(' ', 'T')) - Date.now();
  const h = Math.round(diff / 3_600_000);
  if (h < 0) return `已超时 ${Math.abs(h)}h`;
  if (h < 48) return `剩 ${h}h`;
  return `剩 ${Math.round(h / 24)}d`;
}
const isOverdue = (e: Ev) => !!e.due_at && Date.parse(e.due_at.replace(' ', 'T')) < Date.now() && (e.status === 0 || e.status === 1);
</script>

<style scoped>
.ev-list { display: flex; flex-direction: column; gap: 8px; }
.ev-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid #ebeef5; border-radius: 6px; }
.ev-row:hover { border-color: #c6e2ff; background: #fafcff; }
.ev-main { flex: 1; min-width: 0; cursor: pointer; }
.ev-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ev-target { font-weight: 600; font-size: 14px; }
.ev-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.chip { font-size: 11px; color: #606266; background: #f2f3f5; border-radius: 3px; padding: 1px 6px; }
.ev-side { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.ev-due { font-size: 12px; color: #909399; min-width: 62px; text-align: right; }
.ev-due.overdue { color: #f56c6c; font-weight: 600; }
</style>
