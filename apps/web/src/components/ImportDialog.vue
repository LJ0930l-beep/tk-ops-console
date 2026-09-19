<template>
  <el-button v-if="allowed" :icon="Upload" @click="openDialog">{{ buttonText }}</el-button>

  <el-dialog v-model="visible" :title="`表格导入 · ${meta?.label ?? table}`" width="900px" destroy-on-close>
    <el-alert type="info" :closable="false" show-icon class="tip-alert">
      <template #title>
        官方接口覆盖不到的数据，用卖家中心 / 罗面导出的表格兜底。表头认中文标签也认英文字段名；
        同一业务键重复导入只更新不新增；不合法的行会被单独拒绝并给出原因，其余行照常入库。
      </template>
    </el-alert>

    <div class="head-row">
      <el-radio-group v-model="source">
        <el-radio-button value="manual">人工表格 / 粘贴</el-radio-button>
        <el-radio-button value="web">浏览器抓取回传</el-radio-button>
      </el-radio-group>
      <div class="head-actions">
        <el-button link type="primary" :icon="Download" :loading="downloading" @click="downloadTemplate">下载模板</el-button>
        <el-button link :icon="Delete" @click="clearAll">清空</el-button>
      </div>
    </div>

    <el-tabs v-model="tab">
      <el-tab-pane label="粘贴内容" name="paste">
        <el-input
          v-model="rawText"
          type="textarea"
          :rows="8"
          resize="vertical"
          spellcheck="false"
          placeholder="在卖家中心 / 罗面的表格里选中数据区域（含表头）Ctrl+C，然后在这里 Ctrl+V。Excel 粘贴为制表符分隔，逗号 CSV 同样支持。"
        />
      </el-tab-pane>
      <el-tab-pane label="上传 CSV / TXT 文件" name="file">
        <el-upload drag :auto-upload="false" :show-file-list="false" accept=".csv,.txt,.tsv" :on-change="onFile">
          <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
          <div class="el-upload__text">拖拽文件到此处，或<em>点击选择</em></div>
          <template #tip>
            <div class="el-upload__tip">单文件不超过 {{ limit }} 行；UTF-8 编码的 CSV / TXT（Excel 请「另存为 CSV UTF-8」）。</div>
          </template>
        </el-upload>
      </el-tab-pane>
    </el-tabs>

    <template v-if="parse.error">
      <el-alert type="error" :closable="false" show-icon :title="parse.error" class="tip-alert" />
    </template>
    <template v-else-if="parse.rows.length">
      <div class="meta-row">
        <el-tag type="success" size="small">识别到 {{ parse.rows.length }} 行 × {{ parse.headers.length }} 列</el-tag>
        <el-tag size="small">分隔符：{{ parse.delimiter === '\t' ? '制表符（Excel 粘贴）' : '逗号（CSV）' }}</el-tag>
        <span class="tip">预览前 {{ Math.min(5, parse.rows.length) }} 行：</span>
      </div>
      <el-table :data="preview" border size="small" max-height="220" style="width: 100%">
        <el-table-column v-for="h in parse.headers" :key="h" :prop="h" :label="h" min-width="130" show-overflow-tooltip />
      </el-table>
    </template>

    <el-collapse v-model="colsPanel" class="cols-collapse">
      <el-collapse-item :title="`字段要求（${meta?.columns.length ?? 0} 列，带 * 为必填）`" name="cols">
        <el-table :data="meta?.columns ?? []" border size="small" style="width: 100%">
          <el-table-column prop="label" label="表头（中文）" width="150">
            <template #default="{ row }">{{ row.label }}<span v-if="row.required" class="required">*</span></template>
          </el-table-column>
          <el-table-column prop="key" label="字段名（英文）" width="150" />
          <el-table-column prop="sample" label="示例" width="160" show-overflow-tooltip />
          <el-table-column prop="hint" label="说明" min-width="220" show-overflow-tooltip />
        </el-table>
      </el-collapse-item>
    </el-collapse>

    <template v-if="result">
      <el-alert
        :type="result.failed ? (result.accepted ? 'warning' : 'error') : 'success'"
        :closable="false"
        show-icon
        class="tip-alert"
        :title="`新增 ${result.inserted} 行、更新 ${result.updated} 行、拒绝 ${result.failed} 行（共 ${result.total} 行）`"
      />
      <el-table v-if="result.errors.length" :data="result.errors" border size="small" max-height="200" style="width: 100%">
        <el-table-column prop="row" label="行号" width="70" />
        <el-table-column prop="reason" label="拒绝原因" min-width="420" show-overflow-tooltip />
      </el-table>
    </template>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!parse.rows.length" @click="submit">
        确认导入 {{ parse.rows.length ? `${parse.rows.length} 行` : '' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Delete, Download, Upload, UploadFilled } from '@element-plus/icons-vue';
import { apiDownload, apiGet, apiPost, errMsg } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import type { MenuKey } from '@tk/shared';

interface ColumnMeta {
  key: string;
  label: string;
  required: boolean;
  sample: string;
  hint: string;
}
interface TableMeta {
  table: string;
  label: string;
  menu: MenuKey;
  row_limit: number;
  columns: ColumnMeta[];
}
interface ImportResult {
  total: number;
  accepted: number;
  inserted: number;
  updated: number;
  failed: number;
  errors: { row: number; reason: string }[];
}

const props = withDefaults(defineProps<{ table: string; buttonText?: string }>(), { buttonText: '表格导入' });
const emit = defineEmits<{ (e: 'done', result: ImportResult): void }>();

const auth = useAuthStore();
const visible = ref(false);
const tab = ref<'paste' | 'file'>('paste');
const source = ref<'manual' | 'web'>('manual');
const rawText = ref('');
const submitting = ref(false);
const downloading = ref(false);
const colsPanel = ref<string[]>([]);
const result = ref<ImportResult | null>(null);
const meta = ref<TableMeta | null>(null);
const limit = ref(5000);

/** 元数据全局取一次即可（所有导入页共用同一份注册表） */
let metaCache: Promise<TableMeta[]> | null = null;
const loadTables = (): Promise<TableMeta[]> => (metaCache ??= apiGet<TableMeta[]>('/system/import/tables'));

/** 有目标表菜单才给入口；后端仍会逐条按菜单与店铺范围把关 */
const allowed = computed(() => auth.roleKey === 'boss' || (!!meta.value && auth.menus.includes(meta.value.menu)));

const parse = computed(() => parseTable(rawText.value, limit.value));
const preview = computed(() => parse.value.rows.slice(0, 5));

function parseTable(text: string, maxRows: number): { headers: string[]; rows: Record<string, string>[]; delimiter: string; error: string } {
  const empty = { headers: [], rows: [], delimiter: ',', error: '' };
  const cleaned = text.replace(/^\uFEFF/, '');
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return { ...empty, error: lines.length ? '只有一行：请连同表头一起粘贴或选择文件' : '' };
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const cut = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delimiter) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = cut(lines[0]).filter((h) => h !== '');
  if (!headers.length) return { ...empty, error: '表头为空，无法识别列名' };
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const cells = cut(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { if (cells[i] !== undefined && cells[i] !== '') row[h] = cells[i]; });
    if (Object.keys(row).length) rows.push(row);
  }
  if (!rows.length) return { ...empty, error: '表头以下没有有效数据行' };
  if (rows.length > maxRows) return { ...empty, error: `本次 ${rows.length} 行超过单次导入上限 ${maxRows} 行，请拆分文件` };
  return { headers, rows, delimiter, error: '' };
}

function openDialog() {
  visible.value = true;
  result.value = null;
}

onMounted(async () => {
  try {
    const tables = await loadTables();
    meta.value = tables.find((t) => t.table === props.table) ?? null;
    limit.value = meta.value?.row_limit ?? limit.value;
  } catch {
    /* 元数据取不到时按钮不显示，列表页原有能力不受影响 */
  }
});

function onFile(file: { raw?: File }) {
  const raw = file.raw;
  if (!raw) return;
  raw.text().then((t) => { rawText.value = t; tab.value = 'paste'; });
}

function clearAll() {
  rawText.value = '';
  result.value = null;
}

async function downloadTemplate() {
  if (!meta.value) return;
  downloading.value = true;
  try {
    await apiDownload('/system/import/template', { table: props.table }, `import-${props.table}.csv`);
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    downloading.value = false;
  }
}

async function submit() {
  if (!parse.value.rows.length) return;
  submitting.value = true;
  try {
    const out = await apiPost<ImportResult>('/system/import', { table: props.table, source: source.value, rows: parse.value.rows });
    result.value = out;
    if (out.failed === 0) ElMessage.success(`成功导入 ${out.accepted} 行`);
    emit('done', out);
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.tip-alert {
  margin-bottom: 12px;
}
.head-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.head-actions {
  display: flex;
  gap: 8px;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0 6px;
}
.tip {
  color: #909399;
  font-size: 12px;
}
.cols-collapse {
  margin-top: 12px;
}
.required {
  color: #f56c6c;
  margin-left: 2px;
}
</style>
