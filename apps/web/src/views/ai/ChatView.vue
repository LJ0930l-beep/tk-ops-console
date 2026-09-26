<template>
  <div class="page">
    <PageHeader title="AI 对话" :sub="headSub">
      <template #tag>
        <el-tag v-if="current" size="small" type="info">{{ current.name }} · {{ current.model }}</el-tag>
        <el-tag v-else size="small" type="warning">未选择服务商</el-tag>
      </template>
      <template #actions>
        <el-select v-model="providerId" placeholder="默认服务商" clearable style="width: 220px" :loading="loadingProviders">
          <el-option v-for="p in providers" :key="p.id" :label="`${p.name}（${p.model}）`" :value="p.id" />
        </el-select>
        <el-button :icon="Plus" @click="newChat">新对话</el-button>
      </template>
    </PageHeader>

    <el-alert v-if="!loadingProviders && !providers.length" type="warning" :closable="false" show-icon class="page-card">
      <template #title>
        还没有配置任何可用的模型服务商，所以现在问什么都只会得到一句报错。
        到「AI 助手 → 模型服务商」新增一家（OpenAI / DeepSeek / Gemini / 自定义网关），填上 API Key 并「测活」通过后回来。
      </template>
      <template #default>
        <el-button type="primary" size="small" style="margin-top: 8px" @click="router.push('/ai/providers')">去配置服务商</el-button>
      </template>
    </el-alert>

    <el-row :gutter="12">
      <!-- 左：会话列表 -->
      <el-col :span="5">
        <el-card shadow="never" class="side-card">
          <template #header><b>历史会话</b><span class="head-tip">{{ conversations.length }} 个</span></template>
          <el-input v-model="convKeyword" size="small" placeholder="搜标题" clearable style="margin-bottom: 8px" @keyup.enter="loadConversations" />
          <el-scrollbar max-height="560px">
            <div v-for="c in conversations" :key="c.id" class="conv" :class="{ active: c.id === conversationId }" @click="openConversation(c.id)">
              <div class="conv-title">{{ c.title }}</div>
              <div class="conv-meta">{{ c.message_count }} 条 · {{ String(c.last_message_at ?? c.created_at ?? '').slice(5, 16) }}</div>
              <el-button class="conv-del" link type="danger" size="small" @click.stop="removeConversation(c.id)">删除</el-button>
            </div>
            <el-empty v-if="!conversations.length" :image-size="48" description="还没有会话" />
          </el-scrollbar>
        </el-card>
      </el-col>

      <!-- 右：对话主体 -->
      <el-col :span="19">
        <el-card shadow="never" class="thread-card">
          <template #header>
            <b>对话</b>
            <span class="head-tip">
              AI 只能按白名单工具读写：{{ toolNames }}。它能看见和改动的数据，永远以你这个账号的权限为限。
            </span>
          </template>

          <el-scrollbar ref="scrollerRef" height="480px" class="thread">
            <div v-if="!messages.length && !sending" class="hints">
              <div class="hints-title">试试这样问</div>
              <button v-for="h in HINTS" :key="h" class="hint" type="button" @click="ask(h)">{{ h }}</button>
            </div>
            <div v-for="(m, i) in messages" :key="i" class="msg" :class="`msg-${m.role}`">
              <div class="msg-who">{{ roleLabel(m.role) }}</div>
              <div class="msg-body">
                <template v-if="m.role === 'tool'">
                  <el-tag size="small" :type="m.ok === false ? 'danger' : 'info'" effect="plain">工具 {{ m.tool_name }}</el-tag>
                  <pre class="tool-json">{{ pretty(m.content) }}</pre>
                </template>
                <template v-else>
                  <div class="msg-text">{{ m.content || (m.tool_calls ? '' : '…') }}</div>
                  <div v-if="m.tool_calls" class="chips">
                    <el-tag v-for="c in m.tool_calls" :key="c.id" size="small" type="warning" effect="plain">
                      调用 {{ labelOf(c.name) }}
                    </el-tag>
                  </div>
                  <div v-if="m.latency_ms" class="msg-meta">{{ m.latency_ms }} ms</div>
                </template>
              </div>
            </div>
            <div v-if="sending" class="msg msg-assistant">
              <div class="msg-who">助手</div>
              <div class="msg-body"><el-skeleton :rows="2" animated /></div>
            </div>
          </el-scrollbar>

          <div class="composer">
            <el-input
              v-model="draft"
              type="textarea"
              :rows="3"
              maxlength="8000"
              show-word-limit
              :disabled="sending || !providers.length"
              placeholder="问经营数字、让它查预警、或让它把跟进结果记下来（Ctrl+Enter 发送）"
              @keydown.ctrl.enter.prevent="send"
            />
            <div class="composer-bar">
              <span class="usage">{{ usageText }}</span>
              <el-button type="primary" :loading="sending" :disabled="!draft.trim() || !providers.length" @click="send">发送</el-button>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
/**
 * AI 对话页。
 *
 * 两个刻意的选择：
 *  - 非流式：内部系统一问一答够用，而且 EventSource 带不上 Authorization 头，
 *    要做流式得先把鉴权改成 cookie 或短期票据 —— 那是另一整件事，不在这里顺手改。
 *  - 超时必须单独放宽：出网给模型的超时是服务端 45s，前端 axios 默认 30s 会先把请求掐了，
 *    表现为"AI 明明在算，界面报了个网络错误"。
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { AI_TOOL_LABELS, type AiToolName } from '@tk/shared';
import { apiDelete, apiGet, errMsg, http, payload, type Paged } from '@/api/client';
import PageHeader from '@/components/PageHeader.vue';

interface ChatMessage {
  role: string;
  content: string;
  tool_name?: string | null;
  tool_calls?: { id: string; name: string; arguments: string }[] | null;
  latency_ms?: number;
  ok?: boolean;
}
interface Provider { id: number; name: string; model: string }
interface Conversation { id: number; title: string; message_count: number; last_message_at?: string | null; created_at?: string }

const HINTS = [
  '最近 30 天哪个店在亏钱？亏在哪一项',
  '把现在 P0 的预警列一下，并说明该先处理哪条',
  '按达人维度看，返点最高但投产比最差的是谁',
];

const router = useRouter();
const providers = ref<Provider[]>([]);
const loadingProviders = ref(false);
const providerId = ref<number | undefined>();
const conversations = ref<Conversation[]>([]);
const convKeyword = ref('');
const conversationId = ref<number | undefined>();
const messages = ref<ChatMessage[]>([]);
const draft = ref('');
const sending = ref(false);
const tools = ref<{ name: string; label: string; write: boolean }[]>([]);
const usage = ref<{ prompt_tokens?: number; completion_tokens?: number; cost_cny?: number; rounds?: number; provider?: string }>({});
const scrollerRef = ref();

const current = computed(() => providers.value.find((p) => p.id === providerId.value) ?? (providers.value.length === 1 ? providers.value[0] : null));
const headSub = 'AI 不凭记忆报数：要数字必须调工具现取；写入只认白名单，且落库的"操作人"是你本人';
const toolNames = computed(() => tools.value.map((t) => t.label).join(' / ') || '（还没加载到工具清单）');
const usageText = computed(() => {
  const u = usage.value;
  if (!u.prompt_tokens) return '本轮还没有用量统计';
  return `${u.provider ?? ''} · 输入 ${u.prompt_tokens} / 输出 ${u.completion_tokens} token · ${u.rounds} 轮${u.cost_cny ? ` · 估算 ¥${u.cost_cny}` : ''}`;
});

const roleLabel = (r: string) => (r === 'user' ? '我' : r === 'tool' ? '工具返回' : '助手');
const labelOf = (name: string) => tools.value.find((t) => t.name === name)?.label ?? AI_TOOL_LABELS[name as AiToolName] ?? name;
const pretty = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 1).slice(0, 1200);
  } catch {
    return String(text ?? '').slice(0, 1200);
  }
};

async function loadProviders(): Promise<void> {
  loadingProviders.value = true;
  try {
    providers.value = (await apiGet<Provider[]>('/ai/providers/all')) ?? [];
  } catch (e) {
    providers.value = [];
    ElMessage.error(errMsg(e));
  } finally {
    loadingProviders.value = false;
  }
}

async function loadConversations(): Promise<void> {
  try {
    const res = await apiGet<Paged<Conversation>>('/ai/conversations', { page: 1, pageSize: 50, keyword: convKeyword.value || undefined });
    conversations.value = res.list ?? [];
  } catch {
    conversations.value = [];
  }
}

async function openConversation(id: number): Promise<void> {
  conversationId.value = id;
  usage.value = {};
  try {
    const res = await apiGet<{ messages: ChatMessage[] }>(`/ai/conversations/${id}`);
    messages.value = (res.messages ?? []).map((m) => ({
      role: m.role,
      content: m.content,
      tool_name: m.tool_name,
      tool_calls: m.tool_calls ? (JSON.parse(String(m.tool_calls)) as ChatMessage['tool_calls']) : null,
      latency_ms: m.latency_ms,
    }));
    void scrollBottom();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

async function removeConversation(id: number): Promise<void> {
  try {
    await apiDelete(`/ai/conversations/${id}`);
    if (conversationId.value === id) newChat();
    await loadConversations();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

function newChat(): void {
  conversationId.value = undefined;
  messages.value = [];
  usage.value = {};
}

function ask(text: string): void {
  draft.value = text;
  void send();
}

async function send(): Promise<void> {
  const content = draft.value.trim();
  if (!content || sending.value) return;
  messages.value.push({ role: 'user', content });
  draft.value = '';
  sending.value = true;
  void scrollBottom();
  try {
    const res = payload<{ conversation_id: number; provider: Provider; messages: ChatMessage[]; usage: { prompt_tokens: number; completion_tokens: number; cost_cny: number; rounds: number } }>(
      // 单独放宽超时：服务端出网给模型最多 45s，跟着 axios 默认的 30s 会先把这一枪掐掉
      await http.post('/ai/chat', { content, conversation_id: conversationId.value, provider_id: current.value?.id }, { timeout: 60_000 }),
    );
    conversationId.value = res.conversation_id;
    messages.value.push(...(res.messages ?? []));
    usage.value = { ...res.usage, provider: res.provider?.name };
    await loadConversations();
  } catch (e) {
    const msg = errMsg(e);
    messages.value.push({ role: 'assistant', content: `这次没问到答案：${msg}` });
    ElMessage.error(msg);
  } finally {
    sending.value = false;
    void scrollBottom();
  }
}

async function scrollBottom(): Promise<void> {
  await nextTick();
  const el = scrollerRef.value?.wrapRef as HTMLElement | undefined;
  if (el) el.scrollTop = el.scrollHeight;
}

onMounted(async () => {
  tools.value = (await apiGet<{ name: string; label: string; write: boolean }[]>('/ai/tools').catch(() => [])) ?? [];
  await Promise.all([loadProviders(), loadConversations()]);
});
</script>

<style scoped>
.side-card,
.thread-card {
  margin-bottom: var(--tk-s4);
}
.side-card :deep(.el-card__body),
.thread-card :deep(.el-card__body) {
  padding: var(--tk-s3);
}
.conv {
  position: relative;
  padding: 8px 10px;
  border: 1px solid var(--tk-line);
  border-radius: var(--tk-r-md);
  margin-bottom: var(--tk-s2);
  cursor: pointer;
  transition: border-color var(--tk-dur) var(--tk-ease), background var(--tk-dur) var(--tk-ease);
}
.conv:hover {
  border-color: var(--tk-primary);
  background: var(--tk-surface-2);
}
.conv.active {
  border-color: var(--tk-primary);
  background: #ecf5ff;
}
.conv-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-right: 44px;
}
.conv-meta {
  font-size: 11px;
  color: var(--tk-muted);
}
.conv-del {
  position: absolute;
  right: 6px;
  top: 6px;
  opacity: 0;
  transition: opacity var(--tk-dur) var(--tk-ease);
}
.conv:hover .conv-del {
  opacity: 1;
}
.thread {
  padding-right: var(--tk-s3);
}
.msg {
  display: flex;
  gap: 10px;
  margin-bottom: var(--tk-s3);
  animation: tk-fade-up var(--tk-dur) var(--tk-ease) both;
}
.msg-who {
  flex: none;
  width: 56px;
  font-size: 12px;
  color: var(--tk-muted);
  padding-top: 6px;
}
.msg-body {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--tk-line);
  border-radius: var(--tk-r-md);
  padding: 8px 12px;
  background: var(--tk-surface);
}
.msg-user .msg-body {
  background: #ecf5ff;
  border-color: #d9ecff;
}
.msg-tool .msg-body {
  background: var(--tk-surface-2);
}
.msg-text {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 20px;
}
.msg-meta {
  font-size: 11px;
  color: var(--tk-faint);
  margin-top: 4px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.tool-json {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 16px;
  max-height: 160px;
  overflow: auto;
  color: var(--tk-ink-2);
}
.composer {
  border-top: 1px solid var(--tk-line);
  padding-top: var(--tk-s3);
}
.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--tk-s2);
}
.usage {
  font-size: 12px;
  color: var(--tk-muted);
}
.hints {
  display: flex;
  flex-direction: column;
  gap: var(--tk-s2);
  padding: var(--tk-s4) 0;
}
.hints-title {
  font-size: 12px;
  color: var(--tk-muted);
}
.hint {
  text-align: left;
  border: 1px dashed var(--tk-border);
  background: var(--tk-surface);
  border-radius: var(--tk-r-md);
  padding: 8px 12px;
  font-size: 13px;
  color: var(--tk-ink-2);
  cursor: pointer;
  transition: border-color var(--tk-dur) var(--tk-ease), transform var(--tk-dur) var(--tk-ease);
}
.hint:hover {
  border-color: var(--tk-primary);
  border-style: solid;
  transform: translateX(3px);
}
</style>
