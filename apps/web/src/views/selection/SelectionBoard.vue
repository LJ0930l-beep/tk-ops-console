<template>
  <div class="page">
    <!-- 一条筛选栏同时驱动漏斗 / 看板 / 列表 / 淘汰池：避免「看板看得见、列表少一批」的两套口径 -->
    <el-card class="page-card" shadow="never">
      <el-form inline @submit.prevent="reloadAll">
        <el-form-item label="关键词">
          <el-input v-model="filters.keyword" clearable placeholder="品名 / 候选品 ID / 供应商 / 类目" style="width: 210px" @keyup.enter="reloadAll" />
        </el-form-item>
        <el-form-item label="负责人">
          <el-select v-model="filters.owner_id" clearable filterable placeholder="全部" style="width: 140px">
            <el-option v-for="u in owners" :key="u.id" :label="u.real_name" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="店铺">
          <el-select v-model="filters.shop_id" clearable filterable placeholder="全部" style="width: 150px">
            <el-option v-for="o in shopOpts" :key="String(o.value)" :label="String(o.label)" :value="Number(o.value)" />
          </el-select>
        </el-form-item>
        <el-form-item label="来源">
          <el-select v-model="filters.source" clearable placeholder="全部" style="width: 130px">
            <el-option v-for="s in SELECTION_SOURCES" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="测试结论">
          <el-select v-model="filters.conclusion" clearable placeholder="全部" style="width: 130px">
            <el-option v-for="o in CONCLUSION_OPTIONS" :key="String(o.value)" :label="o.label" :value="Number(o.value)" />
          </el-select>
        </el-form-item>
        <el-form-item label="只看超时">
          <el-switch v-model="filters.overdue" @change="reloadAll" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="reloadAll">查询</el-button>
          <el-button :icon="RefreshLeft" @click="resetFilters">重置</el-button>
        </el-form-item>
      </el-form>
      <div class="toolbar">
        <span class="tip">{{ thresholdTip }}</span>
        <span class="toolbar-right">
          <el-button :icon="Refresh" :loading="boardLoading || funnelLoading" @click="reloadAll">刷新</el-button>
          <el-button v-if="canWrite" type="primary" :icon="Plus" @click="openRegister">登记候选品</el-button>
        </span>
      </div>
    </el-card>

    <!-- 方案 11.3 顶部漏斗：纯 DOM 条形，不为四根柱子引 echarts（首屏不涨） -->
    <el-card class="page-card" shadow="never">
      <div class="head">
        <div>
          <span class="title">选品漏斗</span>
          <span class="tip">登记 → 进入测试 → 测试通过 → 上架销售；比率为相邻两级之比</span>
        </div>
        <div class="summary">
          总通过率 <b>{{ pctOf(funnel?.pass_rate) }}</b>
          <span class="sep">｜</span>淘汰 <b>{{ num(funnel?.eliminated) }}</b> 个
          <span class="sep">｜</span>在办
          <b>{{ num(funnel?.levels?.stage_1) }}</b>/登记
          <b>{{ num(funnel?.levels?.stage_2) }}</b>/测试
          <b>{{ num(funnel?.levels?.stage_3) }}</b>/反馈
          <b>{{ num(funnel?.levels?.stage_4) }}</b>/准备
        </div>
      </div>
      <el-alert v-if="funnelError" type="error" :closable="false" show-icon :title="`漏斗加载失败：${funnelError}`" />
      <div v-else v-loading="funnelLoading" class="funnel">
        <div v-for="(s, i) in funnelSteps" :key="s.key" class="fstep">
          <div class="frow"><span class="flabel">{{ s.label }}</span><span class="fvalue">{{ s.value }}</span></div>
          <div class="fbar"><i :style="{ width: `${s.bar}%` }" /></div>
          <div class="frate">{{ i === 0 ? '漏斗起点' : `相邻转化 ${pctOf(s.rate)}` }}</div>
        </div>
        <el-empty v-if="!funnelLoading && !funnelSteps.length" description="一个候选品都没有：点右上「登记候选品」开始跑流水线" :image-size="52" />
      </div>
    </el-card>

    <el-card shadow="never">
      <el-tabs v-model="tab">
        <el-tab-pane label="流水线看板" name="board">
          <el-alert v-if="boardError" type="error" :closable="false" show-icon :title="`看板加载失败：${boardError}`" class="page-card" />
          <div v-loading="boardLoading" class="board">
            <el-card v-for="col in columns" :key="col.stage" shadow="never" class="col">
              <template #header>
                <div class="col-head">
                  <span class="col-title">{{ col.title }}</span>
                  <span>
                    <el-tag size="small" type="info">{{ col.cards.length }}</el-tag>
                    <el-tag v-if="col.over > 0" size="small" type="danger" class="ml4">超时 {{ col.over }}</el-tag>
                  </span>
                </div>
              </template>
              <div v-for="c in col.cards" :key="c.id" class="scard" :class="'lv-' + levelOf(c.overdue_level)">
                <div class="srow">
                  <span class="code">{{ c.code }}</span>
                  <el-tag size="small" effect="plain" :type="LEVEL_TAG[levelOf(c.overdue_level)]">{{ LEVEL_LABEL[levelOf(c.overdue_level)] }}</el-tag>
                </div>
                <div class="sname">{{ c.name }}</div>
                <div class="smeta">停留 {{ c.dwell_days }} 天{{ c.due_days == null ? '（该阶段无超时口径）' : ` / 超时线 ${c.due_days} 天` }}</div>
                <div class="smeta">负责人：{{ c.owner_name || '未指派' }}<span v-if="c.shop_name"> · {{ c.shop_name }}</span></div>
                <div v-if="cardMetrics(c).length" class="smetrics">
                  <span v-for="m in cardMetrics(c)" :key="m.label">{{ m.label }} {{ m.text }}</span>
                </div>
                <div class="sacts">
                  <el-button v-for="a in actionsOf(c)" :key="a.key" link size="small" :type="a.type" :icon="a.icon" @click="runAct(a, c)">{{ a.label }}</el-button>
                </div>
              </div>
              <el-empty v-if="!col.cards.length" :image-size="46" :description="EMPTY_HINT[col.stage] ?? '暂无候选品'" />
            </el-card>
          </div>
        </el-tab-pane>

        <el-tab-pane label="候选品列表" name="list">
          <ResourcePage
            ref="rpList"
            api="/selection"
            title="候选品"
            :columns="listColumns"
            :extra-query="listExtra"
            :map-row="decorate"
            :createable="false"
            :editable="false"
            :deletable="false"
            :can-write="false"
            :action-width="250"
          >
            <template #toolbar>
              <ExportButton url="/selection/export" name="selection-all" :params="listExtra" />
            </template>
            <template #actions="{ row }">
              <el-button v-for="a in actionsOf(row)" :key="a.key" link size="small" :type="a.type" @click="runAct(a, row)">{{ a.label }}</el-button>
            </template>
          </ResourcePage>
        </el-tab-pane>

        <el-tab-pane label="淘汰池" name="dead">
          <el-alert type="info" :closable="false" show-icon class="page-card" title="淘汰池是资产不是垃圾：原因写清楚，下次选品才不踩同一个坑。复盘后可以「捞回登记」重跑流水线。" />
          <ResourcePage
            ref="rpDead"
            api="/selection"
            title="淘汰候选品"
            :columns="deadColumns"
            :extra-query="deadExtra"
            :map-row="decorate"
            :createable="false"
            :editable="false"
            :deletable="false"
            :can-write="false"
            :action-width="250"
          >
            <template #toolbar>
              <ExportButton url="/selection/export" name="selection-eliminated" :params="deadExtra" />
            </template>
            <template #actions="{ row }">
              <el-button v-for="a in actionsOf(row)" :key="a.key" link size="small" :type="a.type" @click="runAct(a, row)">{{ a.label }}</el-button>
            </template>
          </ResourcePage>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 登记 / 编辑基础信息：stage 与 conclusion 不在这里改（后端 PUT 也改不动，状态只能走流转） -->
    <el-dialog v-model="baseVisible" :title="baseId ? `编辑候选品 · ${baseName}` : '登记候选品'" width="760px" destroy-on-close>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="page-card"
        :title="
          baseId
            ? '这里只改基础信息：阶段与测试结论必须走「流转 / 提交结论」，否则流转日志会缺一条，超时预警也会算错。'
            : '登记即入流水线：后端自动生成候选品 ID（SEL-年份-序号）与预估盈亏平衡 ROAS，并落在「商品选品登记」列等上架测试。'
        "
      />
      <el-form ref="baseRef" v-loading="baseLoading" :model="baseForm" :rules="baseRules" label-width="112px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="品名" prop="name"><el-input v-model="baseForm.name" maxlength="200" placeholder="如 折叠收纳袋（大号）" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="选品来源" prop="source">
              <el-select v-model="baseForm.source" placeholder="必填：来源决定复盘时看哪条路" style="width: 100%">
                <el-option v-for="s in SELECTION_SOURCES" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="类目" prop="category"><el-input v-model="baseForm.category" maxlength="64" placeholder="如 家居收纳" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="供应商" prop="supplier"><el-input v-model="baseForm.supplier" maxlength="128" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="采购价" prop="purchase_price">
              <el-input-number v-model="baseForm.purchase_price" :min="0" :precision="2" :step="1" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="预估毛利率" prop="est_margin">
              <el-input-number v-model="baseForm.est_margin" :min="0" :max="1" :step="0.01" :precision="4" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="起订量" prop="moq">
              <el-input-number v-model="baseForm.moq" :min="0" :precision="0" :step="10" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="交货周期(天)" prop="lead_days">
              <el-input-number v-model="baseForm.lead_days" :min="0" :precision="0" :step="1" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="测试店铺">
              <el-select v-model="baseForm.shop_id" clearable filterable placeholder="可留空，进「上架测试」时必填" style="width: 100%">
                <el-option v-for="o in shopOpts" :key="String(o.value)" :label="String(o.label)" :value="Number(o.value)" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="负责人">
              <el-select v-model="baseForm.owner_id" clearable filterable placeholder="留空＝登记者本人" style="width: 100%">
                <el-option v-for="u in owners" :key="u.id" :label="u.real_name" :value="u.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="主图链接" prop="image_url"><el-input v-model="baseForm.image_url" maxlength="512" placeholder="https://…" /></el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="备注"><el-input v-model="baseForm.remark" type="textarea" :rows="2" maxlength="512" show-word-limit /></el-form-item>
          </el-col>
        </el-row>
        <div class="tip">毛利率按小数填（0.35 = 35%）；盈亏平衡 ROAS 由后端按毛利率算好回传{{ baseBreakeven === null ? '' : `，当前为 ${baseBreakeven}` }}。</div>
      </el-form>
      <template #footer>
        <el-button @click="baseVisible = false">取消</el-button>
        <el-button type="primary" :loading="baseSaving" @click="submitBase">{{ baseId ? '保存' : '登记' }}</el-button>
      </template>
    </el-dialog>

    <!-- 阶段流转：目标阶段与必填项都由后端 next_stages 驱动，前端不抄一份状态机 -->
    <el-dialog v-model="stageVisible" :title="`阶段流转 · ${stageTarget?.code ?? ''}`" width="620px" destroy-on-close>
      <div class="tip page-card">
        当前在「{{ stageLabel(stageTarget?.stage) }}」，已停留 {{ num(stageTarget?.dwell_days) }} 天（{{ LEVEL_LABEL[levelOf(stageTarget?.overdue_level)] }}）。
      </div>
      <el-form ref="stageRef" v-loading="stageLoading" :model="stageForm" :rules="stageRules" label-width="112px">
        <el-form-item label="目标阶段" prop="to_stage">
          <el-select v-model="stageForm.to_stage" placeholder="选择要流转到的阶段" style="width: 100%">
            <el-option v-for="o in stageChoices" :key="String(o.value)" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-alert v-if="!stageLoading && !stageDetail" type="error" :closable="false" show-icon class="page-card" title="目标阶段清单没拉到（状态机出边由后端给，前端不抄一份）：关掉这个对话框再点一次流转。" />
        <el-alert v-else-if="!stageLoading && !stageChoices.length" type="warning" :closable="false" show-icon class="page-card" title="这个阶段的候选品没有可流转的目标（转入「正常销售」后移出选品端口）。" />
        <el-alert v-if="Number(stageTarget?.stage) === SELECTION_STAGE.TESTING" type="info" :closable="false" show-icon class="page-card" title="「测试反馈」这一跳不在这里点：必须用「提交测试结论」并附齐 7 个指标，否则后端拒收。" />
        <el-form-item v-if="stageForm.to_stage === SELECTION_STAGE.TESTING" label="测试店铺" prop="shop_id">
          <el-select v-model="stageForm.shop_id" clearable filterable placeholder="进上架测试必填" style="width: 100%">
            <el-option v-for="o in shopOpts" :key="String(o.value)" :label="String(o.label)" :value="Number(o.value)" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="stageForm.to_stage === SELECTION_STAGE.SELLING" label="关联 SPU" prop="spu_id">
          <el-select v-model="stageForm.spu_id" clearable filterable :placeholder="stageSpuId ? `已关联 SPU#${stageSpuId}，留空即不改` : '必填：数据不重复录入，只做工单流转'" style="width: 100%">
            <el-option v-for="s in spus" :key="s.id" :label="`${s.spu_code} ${s.name_cn}`" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="转派负责人">
          <el-select v-model="stageForm.owner_id" clearable filterable :placeholder="`留空＝仍由 ${stageTarget?.owner_name || '当前负责人'} 负责`" style="width: 100%">
            <el-option v-for="u in owners" :key="u.id" :label="u.real_name" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item :label="stageForm.to_stage === SELECTION_STAGE.ELIMINATED ? '淘汰原因' : '流转说明'" prop="note">
          <el-input v-model="stageForm.note" type="textarea" :rows="3" maxlength="512" show-word-limit :placeholder="noteHint" />
        </el-form-item>
        <el-alert v-if="stageForm.to_stage === SELECTION_STAGE.PREPARING" type="info" :closable="false" show-icon class="page-card" :title="`只有结论为「通过」的能进销售前准备；当前结论：${conclusionLabel(stageTarget?.conclusion)}。`" />
        <el-alert v-if="stageForm.to_stage === SELECTION_STAGE.SELLING && missingChecks.length" type="error" :closable="false" show-icon class="page-card" :title="`清单还差 ${missingChecks.length} 项，后端不会放行：${missingChecks.join('、')}`" />
      </el-form>
      <template #footer>
        <el-button @click="stageVisible = false">取消</el-button>
        <el-button type="primary" :loading="stageSaving" @click="submitStage">确认流转</el-button>
      </template>
    </el-dialog>

    <!-- 测试结论：7 个指标一个都不许少，表单挡在前，后端的 400 文案照样 toast -->
    <el-dialog v-model="conclVisible" :title="`提交测试结论 · ${conclTarget?.code ?? ''}`" width="780px" destroy-on-close>
      <el-alert type="warning" :closable="false" show-icon class="page-card" title="没有数据支撑的测试结论应拒绝提交——曝光/点击率/加购率/转化率/退款率/GMV/净利率，少一个后端都会退回并点名缺哪几个。" />
      <el-form ref="conclRef" :model="conclForm" :rules="conclRules" label-width="112px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="测试结论" prop="conclusion">
              <el-select v-model="conclForm.conclusion" placeholder="必填" style="width: 100%">
                <el-option v-for="v in CONCLUSION_CHOICES" :key="String(v)" :label="conclusionLabel(v)" :value="v" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col v-if="conclForm.conclusion === SELECTION_CONCLUSION.RETEST" :span="24">
            <el-form-item label="建议调整项" prop="adjustments">
              <el-input v-model="conclForm.adjustments" maxlength="1000" placeholder="价格 / 主图 / 标题 / 详情页 / 规格 —— 复测必须写清改了什么，否则复测和上次没区别" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="结论说明" prop="note">
              <el-input v-model="conclForm.note" type="textarea" :rows="2" maxlength="1000" show-word-limit placeholder="为什么通过 / 为什么不通过（淘汰原因会带进淘汰池）" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-divider content-position="left">测试期数据快照（已填 {{ snapshotFilled }}/{{ SELECTION_METRICS.length }}）</el-divider>
        <el-row :gutter="12">
          <el-col v-for="k in SELECTION_METRICS" :key="k" :span="8">
            <el-form-item :label="METRIC_META[k].label" :prop="`snapshot.${k}`" :rules="metricRules(k)">
              <el-input-number
                v-model="conclForm.snapshot[k]"
                :min="METRIC_META[k].min"
                :max="METRIC_META[k].max"
                :precision="METRIC_META[k].precision"
                :step="METRIC_META[k].step"
                controls-position="right"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <div class="tip">比率类指标按小数填（0.025 = 2.5%），与规则中心的 CTR / CVR 基准同一口径；GMV 用店铺币种。</div>
      </el-form>
      <template #footer>
        <el-button @click="conclVisible = false">取消</el-button>
        <el-button type="primary" :loading="conclSaving" @click="submitConclusion">提交结论</el-button>
      </template>
    </el-dialog>

    <!-- 销售前准备清单：六项 + 每项责任人 / 时限（只有阶段四能改，后端会拒） -->
    <el-dialog v-model="ckVisible" :title="`销售前准备清单 · ${ckTarget?.code ?? ''}`" width="800px" destroy-on-close>
      <el-alert type="info" :closable="false" show-icon class="page-card" :title="`六项全部勾完才能转「正常销售」（当前 ${ckDone}/${ckRows.length}）；每一项都要落到责任人和时限。`" />
      <el-table v-loading="ckLoading" :data="ckRows" border size="small" style="width: 100%">
        <el-table-column label="完成" width="64" align="center">
          <template #default="{ row }"><el-checkbox v-model="row.done" /></template>
        </el-table-column>
        <el-table-column prop="label" label="清单项" min-width="270" show-overflow-tooltip />
        <el-table-column label="责任人" width="170">
          <template #default="{ row }">
            <el-select v-model="row.owner" clearable filterable size="small" placeholder="指定到人" style="width: 100%">
              <el-option v-for="u in owners" :key="u.id" :label="u.real_name" :value="u.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="时限" width="180">
          <template #default="{ row }"><el-date-picker v-model="row.due" type="date" value-format="YYYY-MM-DD" size="small" style="width: 100%" /></template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="ckVisible = false">取消</el-button>
        <el-button type="primary" :loading="ckSaving" @click="submitChecklist">保存清单</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="logsVisible" :title="`阶段流转日志 · ${logsName}`" size="740px">
      <el-alert type="info" :closable="false" show-icon class="page-card" title="谁在什么时候把它从哪推到哪、为什么——阶段只能经流转/结论接口改变，所以这里的链条是完整的。" />
      <el-table v-loading="logsLoading" :data="logs" border size="small" style="width: 100%">
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ formatUtcTimestamp(row.created_at) || '—' }}</template>
        </el-table-column>
        <el-table-column label="动作" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="ACTION_TAG[String(row.action ?? '')] ?? 'info'">{{ ACTION_LABEL[String(row.action ?? '')] ?? String(row.action ?? '—') }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="流转" width="210">
          <template #default="{ row }">{{ stageLabel(row.from_stage) }} → {{ stageLabel(row.to_stage) }}</template>
        </el-table-column>
        <el-table-column label="操作人" width="100">
          <template #default="{ row }">{{ row.operator_name || '系统' }}</template>
        </el-table-column>
        <el-table-column prop="note" label="说明" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">{{ row.note || '—' }}</template>
        </el-table-column>
        <template #empty><el-empty description="还没有流转记录" :image-size="60" /></template>
      </el-table>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { CircleCheck, Clock, Document, EditPen, Plus, Refresh, RefreshLeft, Search, Sort, Warning } from '@element-plus/icons-vue';
import type { Component } from 'vue';
import {
  SELECTION_BOARD_STAGES,
  SELECTION_CHECKLIST,
  SELECTION_CHECKLIST_KEYS,
  SELECTION_CONCLUSION,
  SELECTION_CONCLUSION_LABELS,
  SELECTION_METRICS,
  SELECTION_SOURCES,
  SELECTION_STAGE,
  SELECTION_STAGE_LABELS,
  num,
  round2,
  type SelectionBoardCard,
  type SelectionLogRow,
  type SelectionSnapshot,
} from '@tk/shared';
import { apiGet, apiPost, apiPut, errMsg } from '@/api/client';
import ResourcePage, { type ColumnDef, type OptionDef } from '@/components/ResourcePage.vue';
import ExportButton from '@/components/ExportButton.vue';
import { useAuthStore } from '@/stores/auth';
import { useDictStore } from '@/stores/dict';
import type { RowLike } from '@/types/row';
import { formatUtcTimestamp } from '@/utils/date';

type Card = SelectionBoardCard;
type Level = Card['overdue_level'];
type MetricKey = (typeof SELECTION_METRICS)[number];

interface BoardColumn {
  stage: number;
  title: string;
  cards: Card[];
  over: number;
}
interface Thresholds {
  test_due_days: number;
  conclusion_due_days: number;
  feedback_due_days: number;
  prepare_due_days: number;
  first_check_hours: number;
  warn_ratio: number;
}
interface BoardData {
  columns: BoardColumn[];
  thresholds: Thresholds;
}
interface FunnelData {
  steps: { key: string; label: string; value: number; rate?: number }[];
  eliminated: number;
  pass_rate: number;
  levels?: Record<string, number>;
  thresholds?: Thresholds;
}
interface ChecklistState {
  done?: number;
  owner?: number | null;
  due?: string | null;
}
/** GET /selection/:id：卡片字段 + 快照 / 清单（后端把这两列 JSON 解析开了给）/ 状态机出边 */
interface Detail extends Omit<Card, 'checklist'> {
  snapshot: Partial<SelectionSnapshot>;
  checklist: Record<string, ChecklistState>;
  checklist_def: { key: string; label: string }[];
  next_stages: number[];
}

const auth = useAuthStore();
const dict = useDictStore();
const canWrite = computed(() => auth.roleKey === 'boss' || auth.menus.includes('selection'));

/* ---------- 展示口径：标签与档位全部来自 @tk/shared / 后端字段，前端不再算阈值 ---------- */
const LEVEL_LABEL: Record<Level, string> = { ok: '正常', warn: '接近超时', over: '已超时' };
const LEVEL_TAG: Record<Level, 'success' | 'warning' | 'danger'> = { ok: 'success', warn: 'warning', over: 'danger' };
/** 未知档位一律按「正常」上色：颜色只是后端结论的投影，前端不猜 */
const levelOf = (v: unknown): Level => (v === 'warn' || v === 'over' ? v : 'ok');
const stageLabel = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : SELECTION_STAGE_LABELS[Number(v)] ?? `阶段${String(v)}`);
const conclusionLabel = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : SELECTION_CONCLUSION_LABELS[Number(v)] ?? String(v));
const pctOf = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : `${round2(num(v) * 100)}%`);
const CONCLUSION_OPTIONS: OptionDef[] = Object.entries(SELECTION_CONCLUSION_LABELS).map(([k, label]) => ({
  value: Number(k),
  label,
  type: k === '1' ? 'success' : k === '2' ? 'danger' : k === '3' ? 'warning' : 'info',
}));
const STAGE_OPTIONS: OptionDef[] = Object.entries(SELECTION_STAGE_LABELS).map(([k, label]) => ({
  value: Number(k),
  label,
  type: k === '5' ? 'success' : k === '6' ? 'danger' : k === '3' ? 'warning' : 'primary',
}));
/** 可提交的结论：未提交（0）是状态不是选项 */
const CONCLUSION_CHOICES = [SELECTION_CONCLUSION.PASS, SELECTION_CONCLUSION.FAIL, SELECTION_CONCLUSION.RETEST];
const ACTION_LABEL: Record<string, string> = {
  register: '登记',
  transition: '阶段流转',
  submit_conclusion: '提交结论',
  confirm_conclusion: '结论落地',
  checklist: '清单更新',
  edit: '编辑',
};
const ACTION_TAG: Record<string, 'primary' | 'success' | 'warning' | 'info' | 'danger'> = {
  register: 'primary',
  transition: 'primary',
  submit_conclusion: 'warning',
  confirm_conclusion: 'success',
  checklist: 'info',
};
const EMPTY_HINT: Record<number, string> = {
  [SELECTION_STAGE.REGISTERED]: '没有在等的：登记完就该推去上架测试（超期会变红）',
  [SELECTION_STAGE.TESTING]: '没有在测的：从「商品选品登记」流转过来并指定店铺',
  [SELECTION_STAGE.FEEDBACK]: '没有待落地的：在「店铺上架测试」列提交测试结论',
  [SELECTION_STAGE.PREPARING]: '没有准备中的：结论为「通过」后进入',
  [SELECTION_STAGE.SELLING]: '转正常销售后就移出选品端口，去商品中心看它卖得怎样',
};
/** 快照指标：min/max 与后端 zod + 规则中心口径一致（比率 0-1 小数） */
const METRIC_META: Record<MetricKey, { label: string; min: number; max: number; precision: number; step: number }> = {
  impressions: { label: '曝光量', min: 0, max: 99_999_999, precision: 0, step: 100 },
  ctr: { label: '点击率 CTR', min: 0, max: 1, precision: 4, step: 0.001 },
  cart_rate: { label: '加购率', min: 0, max: 1, precision: 4, step: 0.001 },
  cvr: { label: '转化率 CVR', min: 0, max: 1, precision: 4, step: 0.001 },
  refund_rate: { label: '退款率', min: 0, max: 1, precision: 4, step: 0.001 },
  gmv: { label: 'GMV(店铺币种)', min: 0, max: 99_999_999, precision: 2, step: 100 },
  net_margin: { label: '净利率', min: -1, max: 1, precision: 4, step: 0.01 },
};

/* ---------- 选项数据（负责人 / 店铺 / SPU） ---------- */
const owners = ref<{ id: number; real_name: string }[]>([]);
const shopOpts = ref<OptionDef[]>([]);
const spus = ref<{ id: number; spu_code: string; name_cn: string }[]>([]);
let spuLoaded = false;

async function loadOwners(): Promise<void> {
  if (owners.value.length) return;
  // 没有 system 菜单的角色本来就读不了员工表：不发这个请求，否则每次进页面都弹一个「403」，
  // 用户读到的是「坏了」，实际是「没权限」（本轮前面已经踩过一次）
  if (!auth.menus.includes('system') && auth.roleKey !== 'boss') return;
  try {
    const r = await apiGet<{ list?: { id: number; real_name: string }[] } | { id: number; real_name: string }[]>('/system/users', { pageSize: 200 });
    owners.value = Array.isArray(r) ? r : (r.list ?? []);
  } catch (e) {
    owners.value = [];
    // 不静默成空下拉：否则「没人可选」和「接口挂了」长得一模一样
    ElMessage.warning(`负责人列表加载失败：${errMsg(e)}`);
  }
}

async function loadShops(): Promise<void> {
  const list = await dict.shopOptions();
  shopOpts.value = (list ?? []).map((s) => ({ value: s.id, label: s.shop_name }));
}

/** SPU 列表只在真要转「正常销售」时才要，按需加载一次 */
async function loadSpus(): Promise<void> {
  if (spuLoaded) return;
  try {
    spus.value = await apiGet<{ id: number; spu_code: string; name_cn: string }[]>('/products/spu/all');
    spuLoaded = true;
  } catch (e) {
    spus.value = [];
    ElMessage.warning(`商品 SPU 列表加载失败：${errMsg(e)}`);
  }
}

/* ---------- 筛选 ---------- */
const filters = reactive<{ keyword: string; owner_id?: number; shop_id?: number; source?: string; conclusion?: number; overdue: boolean }>({
  keyword: '',
  owner_id: undefined,
  shop_id: undefined,
  source: undefined,
  conclusion: undefined,
  overdue: false,
});
/** 后端把空串当「不过滤」，但 source 是枚举、空串会被 zod 拒收，所以未选就整个键不发 */
const queryPayload = computed<Record<string, unknown>>(() => ({
  keyword: filters.keyword.trim() || undefined,
  owner_id: filters.owner_id,
  shop_id: filters.shop_id,
  source: filters.source || undefined,
  conclusion: filters.conclusion,
  overdue: filters.overdue ? 1 : undefined,
}));
const listExtra = computed<Record<string, unknown>>(() => ({ ...queryPayload.value }));
const deadExtra = computed<Record<string, unknown>>(() => ({ ...queryPayload.value, stage: SELECTION_STAGE.ELIMINATED }));

function resetFilters(): void {
  filters.keyword = '';
  filters.owner_id = undefined;
  filters.shop_id = undefined;
  filters.source = undefined;
  filters.conclusion = undefined;
  filters.overdue = false;
  void reloadAll();
}

/* ---------- 漏斗 + 看板 ---------- */
const tab = ref<'board' | 'list' | 'dead'>('board');
const rpList = ref();
const rpDead = ref();
const funnel = ref<FunnelData | null>(null);
const funnelLoading = ref(false);
const funnelError = ref('');
const boardLoading = ref(false);
const boardError = ref('');
const thresholds = ref<Thresholds | null>(null);
/** 列骨架先按 shared 枚举铺好：请求失败时列头还在，只剩一条红字告警，不会变成「一片空白」 */
const columns = ref<BoardColumn[]>([...SELECTION_BOARD_STAGES].map((stage) => ({ stage, title: stageLabel(stage), cards: [], over: 0 })));

const funnelSteps = computed(() => {
  const steps = funnel.value?.steps ?? [];
  const max = Math.max(1, ...steps.map((s) => num(s.value)));
  return steps.map((s) => ({ key: s.key, label: s.label, value: num(s.value), rate: s.rate, bar: round2((num(s.value) / max) * 100) }));
});

const thresholdTip = computed(() => {
  const t = thresholds.value;
  if (!t) return '超时阈值由后端配置下发；卡片左边框＝超时档位（绿正常 / 黄接近超时 / 红已超时）。';
  return `超时口径（后端配置）：登记待测试 ${t.test_due_days} 天 / 测试出结论 ${t.conclusion_due_days} 天 / 结论落地 ${t.feedback_due_days} 天 / 准备清完 ${t.prepare_due_days} 天，上架 ${t.first_check_hours} 小时内做首次检测；停留满 ${pctOf(t.warn_ratio)} 转黄、超过红线转红`;
});

async function loadFunnel(): Promise<void> {
  funnelLoading.value = true;
  try {
    funnel.value = await apiGet<FunnelData>('/selection/funnel', queryPayload.value);
    if (funnel.value.thresholds) thresholds.value = funnel.value.thresholds;
    funnelError.value = '';
  } catch (e) {
    funnel.value = null;
    // 失败要说清楚：静默成空漏斗，用户读到的是「选品通过率 0%」
    funnelError.value = errMsg(e);
    ElMessage.error(errMsg(e));
  } finally {
    funnelLoading.value = false;
  }
}

async function loadBoard(): Promise<void> {
  boardLoading.value = true;
  try {
    const data = await apiGet<BoardData>('/selection/board', queryPayload.value);
    columns.value = data.columns ?? [];
    thresholds.value = data.thresholds ?? thresholds.value;
    boardError.value = '';
  } catch (e) {
    boardError.value = errMsg(e);
    ElMessage.error(errMsg(e));
  } finally {
    boardLoading.value = false;
  }
}

async function reloadAll(): Promise<void> {
  await Promise.all([loadBoard(), loadFunnel()]);
  rpList.value?.reload();
  rpDead.value?.reload();
}

/* ---------- 卡片：快照解析 + 动作清单 ---------- */
/** 后端把 test_snapshot / checklist 存成 JSON 字符串：坏值按空对象处理，不让整页因为一条脏数据炸掉 */
function parseObj<T>(raw: unknown): T {
  const s = String(raw ?? '').trim();
  if (!s || s === '{}') return {} as T;
  try {
    const parsed = JSON.parse(s) as unknown;
    return (parsed && typeof parsed === 'object' ? parsed : {}) as T;
  } catch {
    return {} as T;
  }
}

function snapshotOf(raw: unknown): Partial<SelectionSnapshot> {
  return parseObj<Partial<SelectionSnapshot>>(raw);
}

/** 卡片只展示方案点名的三项：CTR / 转化率 / 净利率，且只在有快照时显示 */
function cardMetrics(c: RowLike): { label: string; text: string }[] {
  const s = snapshotOf((c as Card).test_snapshot);
  const out: { label: string; text: string }[] = [];
  if (s.ctr !== undefined && s.ctr !== null) out.push({ label: 'CTR', text: pctOf(s.ctr) });
  if (s.cvr !== undefined && s.cvr !== null) out.push({ label: '转化率', text: pctOf(s.cvr) });
  if (s.net_margin !== undefined && s.net_margin !== null) out.push({ label: '净利率', text: pctOf(s.net_margin) });
  return out;
}

type ActKey = 'edit' | 'stage' | 'conclusion' | 'confirm' | 'checklist' | 'logs';
interface Act {
  key: ActKey;
  label: string;
  type: 'primary' | 'success' | 'info' | 'warning' | 'danger';
  icon: Component;
}
const ACT: Record<ActKey, Act> = {
  edit: { key: 'edit', label: '编辑', type: 'primary', icon: EditPen },
  stage: { key: 'stage', label: '流转', type: 'primary', icon: Sort },
  conclusion: { key: 'conclusion', label: '测试结论', type: 'warning', icon: Warning },
  confirm: { key: 'confirm', label: '按结论落地', type: 'success', icon: CircleCheck },
  checklist: { key: 'checklist', label: '准备清单', type: 'warning', icon: Document },
  logs: { key: 'logs', label: '日志', type: 'info', icon: Clock },
};

/** 阶段决定能做什么；「有没有出边」不在这儿判断——那是后端状态机的事，点了它会给文案 */
function actionsOf(raw: RowLike): Act[] {
  const stage = Number((raw as Card).stage);
  const acts: ActKey[] = ['edit'];
  if (stage === SELECTION_STAGE.TESTING) acts.push('conclusion');
  if (stage === SELECTION_STAGE.FEEDBACK) acts.push('confirm');
  if (stage === SELECTION_STAGE.PREPARING) acts.push('checklist');
  acts.push('stage', 'logs');
  return acts.map((k) => ACT[k]);
}

function runAct(a: Act, raw: RowLike): void {
  const card = raw as Card;
  if (a.key === 'edit') openBase(card);
  else if (a.key === 'stage') void openStage(card);
  else if (a.key === 'conclusion') openConclusion(card);
  else if (a.key === 'confirm') void confirmConclusion(card);
  else if (a.key === 'checklist') void openChecklist(card);
  else void openLogs(card);
}

/* ---------- 登记 / 编辑 ---------- */
interface BaseForm {
  name: string;
  source?: string;
  category?: string;
  supplier?: string;
  purchase_price?: number;
  est_margin?: number;
  moq?: number;
  lead_days?: number;
  shop_id?: number;
  owner_id?: number;
  image_url?: string;
  remark?: string;
}
const baseVisible = ref(false);
const baseLoading = ref(false);
const baseSaving = ref(false);
const baseRef = ref<FormInstance>();
const baseId = ref(0);
const baseName = ref('');
const baseBreakeven = ref<number | null>(null);
const baseForm = reactive<BaseForm>({ name: '' });

const rangeRule = (min: number, max: number, label: string) => ({
  validator: (_r: unknown, v: unknown, cb: (e?: Error) => void) => {
    if (v === undefined || v === null || v === '') return cb();
    const n = Number(v);
    cb(Number.isFinite(n) && n >= min && n <= max ? undefined : new Error(`${label}需在 ${min}~${max} 之间`));
  },
  trigger: ['blur', 'change'],
});
const baseRules = computed<FormRules>(() => ({
  name: [
    { required: true, message: '请填写品名', trigger: 'blur' },
    { max: 200, message: '品名不超过 200 字', trigger: 'blur' },
  ],
  source: [{ required: true, message: '请选择选品来源（复盘要看哪条路产出好品）', trigger: 'change' }],
  purchase_price: [{ required: true, message: '请填写采购价', trigger: 'blur' }, rangeRule(0, 99_999_999, '采购价')],
  est_margin: [{ required: true, message: '请填写预估毛利率（小数，0.35 = 35%）', trigger: 'blur' }, rangeRule(0, 1, '预估毛利率')],
  moq: [{ required: true, message: '请填写起订量（0 = 无起订量限制）', trigger: 'blur' }, rangeRule(0, 999_999, '起订量')],
  lead_days: [{ required: true, message: '请填写交货周期，补货节奏要用它', trigger: 'blur' }, rangeRule(0, 3650, '交货周期')],
  image_url: [
    {
      validator: (_r: unknown, v: unknown, cb: (e?: Error) => void) => {
        const s = String(v ?? '').trim();
        cb(!s || /^https?:\/\//i.test(s) ? undefined : new Error('主图链接需以 http:// 或 https:// 开头'));
      },
      trigger: 'blur',
    },
  ],
}));

function openRegister(): void {
  baseId.value = 0;
  baseName.value = '';
  baseBreakeven.value = null;
  for (const k of Object.keys(baseForm) as (keyof BaseForm)[]) delete baseForm[k];
  Object.assign(baseForm, { name: '' });
  baseVisible.value = true;
  void loadOwners();
}

function openBase(card: Card): void {
  baseId.value = Number(card.id);
  baseName.value = String(card.name ?? '');
  baseBreakeven.value = Number.isFinite(Number(card.breakeven_roas)) ? Number(card.breakeven_roas) : null;
  for (const k of Object.keys(baseForm) as (keyof BaseForm)[]) delete baseForm[k];
  Object.assign(baseForm, {
    name: baseName.value,
    source: card.source ?? undefined,
    category: card.category ?? undefined,
    supplier: card.supplier ?? undefined,
    purchase_price: num(card.purchase_price),
    est_margin: num(card.est_margin),
    moq: num(card.moq),
    lead_days: num(card.lead_days),
    shop_id: card.shop_id ?? undefined,
    owner_id: card.owner_id ?? undefined,
    image_url: card.image_url ?? undefined,
    remark: card.remark ?? undefined,
  });
  baseVisible.value = true;
  void loadOwners();
}

/** 后端 zod 的 source 是枚举：空串会被拒，提交前统一剔除空值 */
function bodyOf(f: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    out[k] = v;
  }
  return out;
}

async function submitBase(): Promise<void> {
  const valid = await baseRef.value?.validate().catch(() => false);
  if (!valid) return;
  baseSaving.value = true;
  try {
    const body = bodyOf(baseForm);
    if (baseId.value) await apiPut(`/selection/${baseId.value}`, body);
    else await apiPost('/selection', body);
    ElMessage.success(baseId.value ? '已保存' : '候选品已登记，落在「商品选品登记」列等上架测试');
    baseVisible.value = false;
    await reloadAll();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    baseSaving.value = false;
  }
}

/* ---------- 阶段流转 ---------- */
const stageVisible = ref(false);
const stageLoading = ref(false);
const stageSaving = ref(false);
const stageRef = ref<FormInstance>();
const stageTarget = ref<Card | null>(null);
const stageDetail = ref<Detail | null>(null);
const stageForm = reactive<{ to_stage?: number; note: string; shop_id?: number; spu_id?: number; owner_id?: number }>({ note: '' });

/**
 * 后端状态机的边（next_stages）是唯一真相：「测试反馈」这一跳压根不在出边里，
 * 它由「提交测试结论」接口产生，所以这里不需要再自己排除一次。
 */
const stageChoices = computed<OptionDef[]>(() =>
  (stageDetail.value?.next_stages ?? []).map((s) => ({ value: s, label: `${stageLabel(s)}${s === SELECTION_STAGE.ELIMINATED ? '（写原因）' : ''}` })),
);
const missingChecks = computed<string[]>(() => {
  const ck = stageDetail.value?.checklist ?? {};
  return SELECTION_CHECKLIST.filter((c) => !num(ck[c.key]?.done)).map((c) => c.label);
});
const noteHint = computed(() =>
  stageForm.to_stage === SELECTION_STAGE.ELIMINATED
    ? '必填：淘汰原因会进淘汰池，供下次选品参考（价格带不对 / 类目资质拿不到 / 物流走不了…）'
    : stageForm.to_stage === SELECTION_STAGE.SELLING
      ? '可填上架批次、渠道安排等；正常销售前清单必须全勾完'
      : '可填本次流转的说明（会进流转日志）',
);
/** 已关联的 SPU：详情接口比卡片新，优先信它（详情没回来前用卡片兜底） */
const stageSpuId = computed<number | null>(() => stageDetail.value?.spu_id ?? stageTarget.value?.spu_id ?? null);
const stageRules = computed<FormRules>(() => {
  const r: FormRules = { to_stage: [{ required: true, message: '请选择目标阶段', trigger: 'change' }] };
  if (stageForm.to_stage === SELECTION_STAGE.ELIMINATED) r.note = [{ required: true, message: '淘汰必须写明原因', trigger: 'blur' }];
  if (stageForm.to_stage === SELECTION_STAGE.TESTING) r.shop_id = [{ required: true, message: '进入上架测试必须指定测试店铺', trigger: 'change' }];
  if (stageForm.to_stage === SELECTION_STAGE.SELLING && !stageSpuId.value) r.spu_id = [{ required: true, message: '转正常销售必须关联商品 SPU', trigger: 'change' }];
  return r;
});

async function openStage(card: Card): Promise<void> {
  stageTarget.value = card;
  stageDetail.value = null;
  stageForm.to_stage = undefined;
  stageForm.note = '';
  stageForm.shop_id = card.shop_id ?? undefined;
  stageForm.spu_id = undefined;
  stageForm.owner_id = undefined;
  stageVisible.value = true;
  stageLoading.value = true;
  void loadOwners();
  void loadSpus();
  try {
    stageDetail.value = await apiGet<Detail>(`/selection/${card.id}`);
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    stageLoading.value = false;
  }
}

async function submitStage(): Promise<void> {
  const target = stageTarget.value;
  if (!target) return;
  const valid = await stageRef.value?.validate().catch(() => false);
  if (!valid) return;
  stageSaving.value = true;
  try {
    await apiPost<Card>(`/selection/${target.id}/stage`, bodyOf(stageForm));
    ElMessage.success(`已流转到「${stageLabel(stageForm.to_stage)}」`);
    stageVisible.value = false;
    await reloadAll();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    stageSaving.value = false;
  }
}

/* ---------- 测试结论（7 个指标一个都不能少） ---------- */
const conclVisible = ref(false);
const conclSaving = ref(false);
const conclRef = ref<FormInstance>();
const conclTarget = ref<Card | null>(null);
const emptySnapshot = (): Record<MetricKey, number | undefined> => ({
  impressions: undefined,
  ctr: undefined,
  cart_rate: undefined,
  cvr: undefined,
  refund_rate: undefined,
  gmv: undefined,
  net_margin: undefined,
});
const conclForm = reactive<{ conclusion?: number; note: string; adjustments: string; snapshot: Record<MetricKey, number | undefined> }>({
  conclusion: undefined,
  note: '',
  adjustments: '',
  snapshot: emptySnapshot(),
});
const snapshotFilled = computed(() => SELECTION_METRICS.filter((k) => conclForm.snapshot[k] !== undefined && conclForm.snapshot[k] !== null).length);
const conclRules = computed<FormRules>(() => {
  const r: FormRules = {
    conclusion: [{ required: true, message: '请选择测试结论', trigger: 'change' }],
    note: [{ required: true, message: '必须写明通过 / 不通过的原因（会带进淘汰池供复盘）', trigger: 'blur' }],
  };
  if (conclForm.conclusion === SELECTION_CONCLUSION.RETEST) r.adjustments = [{ required: true, message: '结论为「需调整后复测」时必须写明调整项', trigger: 'blur' }];
  return r;
});

function metricRules(k: MetricKey) {
  const meta = METRIC_META[k];
  return [
    { required: true, message: `${meta.label}必填（缺指标后端会退回）`, trigger: ['blur', 'change'] },
    rangeRule(meta.min, meta.max, meta.label),
  ];
}

function openConclusion(card: Card): void {
  conclTarget.value = card;
  conclForm.conclusion = undefined;
  conclForm.note = '';
  conclForm.adjustments = '';
  conclForm.snapshot = emptySnapshot();
  conclVisible.value = true;
}

async function submitConclusion(): Promise<void> {
  const target = conclTarget.value;
  if (!target) return;
  const valid = await conclRef.value?.validate().catch(() => false);
  if (!valid) return;
  // 兜一道（表单规则已经挡在前面，这里只保证不把半截快照发过去）
  const missing = SELECTION_METRICS.filter((k) => !Number.isFinite(Number(conclForm.snapshot[k])));
  if (missing.length) {
    ElMessage.error(`测试数据快照还缺：${missing.map((k) => METRIC_META[k].label).join(' / ')}`);
    return;
  }
  // 七个键逐个写出来：SelectionSnapshot 少一个字段就编译不过，等于把后端那条硬规则钉在前端
  const snapshot: SelectionSnapshot = {
    impressions: Number(conclForm.snapshot.impressions),
    ctr: Number(conclForm.snapshot.ctr),
    cart_rate: Number(conclForm.snapshot.cart_rate),
    cvr: Number(conclForm.snapshot.cvr),
    refund_rate: Number(conclForm.snapshot.refund_rate),
    gmv: Number(conclForm.snapshot.gmv),
    net_margin: Number(conclForm.snapshot.net_margin),
  };
  conclSaving.value = true;
  try {
    await apiPost<Card>(`/selection/${target.id}/conclusion`, {
      conclusion: conclForm.conclusion,
      note: conclForm.note.trim(),
      adjustments: conclForm.adjustments.trim() || undefined,
      snapshot,
    });
    ElMessage.success('测试结论已记录，候选品进入「测试反馈」；请在该列点「按结论落地」完成分流');
    conclVisible.value = false;
    await reloadAll();
  } catch (e) {
    // 后端「缺哪几个指标」的 400 文案必须原样出来，不许被前端自己盖掉
    ElMessage.error(errMsg(e));
  } finally {
    conclSaving.value = false;
  }
}

async function confirmConclusion(card: Card): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `按结论「${conclusionLabel(card.conclusion)}」落地：通过→销售前准备、需调整后复测→回店铺上架测试、不通过→淘汰池。确认？`,
      `结论落地 · ${card.code}`,
      { confirmButtonText: '确认落地', cancelButtonText: '取消', type: 'warning' },
    );
    const out = await apiPost<Card>(`/selection/${card.id}/conclusion/confirm`, {});
    ElMessage.success(`已按结论流转到「${stageLabel(out?.stage)}」`);
    await reloadAll();
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errMsg(e));
  }
}

/* ---------- 销售前准备清单 ---------- */
interface ChecklistRow {
  key: string;
  label: string;
  done: boolean;
  owner?: number | null;
  due?: string | null;
}
const ckVisible = ref(false);
const ckLoading = ref(false);
const ckSaving = ref(false);
const ckTarget = ref<Card | null>(null);
const ckRows = ref<ChecklistRow[]>([]);
const ckDone = computed(() => ckRows.value.filter((r) => r.done).length);

async function openChecklist(card: Card): Promise<void> {
  ckTarget.value = card;
  ckRows.value = SELECTION_CHECKLIST.map((c) => ({ key: c.key, label: c.label, done: false, owner: null, due: null }));
  ckVisible.value = true;
  ckLoading.value = true;
  void loadOwners();
  try {
    const d = await apiGet<Detail>(`/selection/${card.id}`);
    const defs = d.checklist_def?.length ? d.checklist_def : SELECTION_CHECKLIST.map((c) => ({ key: c.key as string, label: c.label as string }));
    const state = d.checklist ?? {};
    ckRows.value = defs.map((def) => ({
      key: def.key,
      label: def.label,
      done: num(state[def.key]?.done) === 1,
      owner: state[def.key]?.owner ?? null,
      due: state[def.key]?.due ?? null,
    }));
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    ckLoading.value = false;
  }
}

async function submitChecklist(): Promise<void> {
  const target = ckTarget.value;
  if (!target) return;
  const incomplete = ckRows.value.filter((r) => r.done && !r.owner);
  if (incomplete.length) {
    ElMessage.error(`已勾完的项必须指定责任人：${incomplete.map((r) => r.label).join('、')}`);
    return;
  }
  const body: Record<string, { done: number; owner: number | null; due: string | null }> = {};
  for (const r of ckRows.value) body[r.key] = { done: r.done ? 1 : 0, owner: r.owner ?? null, due: r.due ?? null };
  ckSaving.value = true;
  try {
    const out = await apiPut<{ done: number; total: number }>(`/selection/${target.id}/checklist`, body);
    ElMessage.success(`清单进度 ${num(out.done)}/${num(out.total)}${num(out.done) === num(out.total) ? '，可以去流转「正常销售」了' : ''}`);
    ckVisible.value = false;
    await reloadAll();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    ckSaving.value = false;
  }
}

/* ---------- 流转日志 ---------- */
const logsVisible = ref(false);
const logsLoading = ref(false);
const logs = ref<SelectionLogRow[]>([]);
const logsName = ref('');

async function openLogs(card: Card): Promise<void> {
  logsName.value = `${card.code} ${card.name}`;
  logs.value = [];
  logsVisible.value = true;
  logsLoading.value = true;
  try {
    logs.value = await apiGet<SelectionLogRow[]>(`/selection/${card.id}/logs`);
  } catch (e) {
    logs.value = [];
    // 空抽屉会被读成「这条没历史」，失败就得说失败
    ElMessage.error(errMsg(e));
  } finally {
    logsLoading.value = false;
  }
}

/* ---------- 列表 / 淘汰池 ---------- */
function checklistProgress(raw: unknown): string {
  const state = parseObj<Record<string, ChecklistState>>(raw);
  const done = SELECTION_CHECKLIST_KEYS.filter((k) => num(state[k]?.done) === 1).length;
  return `${done}/${SELECTION_CHECKLIST_KEYS.length}`;
}

/** 只加展示字段，不改后端原字段（编辑表单直接吃原值，改了就串单位） */
function decorate(row: Record<string, unknown>): Record<string, unknown> {
  const s = snapshotOf(row.test_snapshot);
  return {
    ...row,
    dwell_text: `${num(row.dwell_days)} 天${row.due_days === null || row.due_days === undefined ? '（无超时口径）' : ` / ${num(row.due_days)}`}`,
    overdue_label: LEVEL_LABEL[levelOf(row.overdue_level)],
    est_margin_pct: num(row.est_margin) * 100,
    ctr_pct: s.ctr === undefined || s.ctr === null ? null : num(s.ctr) * 100,
    cart_rate_pct: s.cart_rate === undefined || s.cart_rate === null ? null : num(s.cart_rate) * 100,
    cvr_pct: s.cvr === undefined || s.cvr === null ? null : num(s.cvr) * 100,
    refund_rate_pct: s.refund_rate === undefined || s.refund_rate === null ? null : num(s.refund_rate) * 100,
    net_margin_pct: s.net_margin === undefined || s.net_margin === null ? null : num(s.net_margin) * 100,
    gmv_text: s.gmv === undefined || s.gmv === null ? '—' : num(s.gmv).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    checklist_text: checklistProgress(row.checklist),
    // 淘汰原因落在 conclusion_note（reject_reason 是同一条的文字化），两处都兜一下再显示
    reject_text: String(row.conclusion_note ?? row.reject_reason ?? '') || '（没写原因，去日志里找）',
    owner_text: row.owner_name || '未指派',
    spu_text: row.spu_id ? `SPU#${String(row.spu_id)}` : '—',
  };
}

const testMetricCols: ColumnDef[] = [
  { prop: 'ctr_pct', label: 'CTR', type: 'percent', width: 84 },
  { prop: 'cvr_pct', label: '转化率', type: 'percent', width: 88 },
  { prop: 'net_margin_pct', label: '净利率', type: 'percent', width: 92 },
];

const listColumns = computed<ColumnDef[]>(() => [
  { prop: 'code', label: '候选品 ID', width: 130, fixed: 'left' },
  { prop: 'name', label: '品名', minWidth: 170 },
  { prop: 'image_url', label: '主图', type: 'image', width: 62 },
  { prop: 'stage', label: '阶段', type: 'tag', options: STAGE_OPTIONS, width: 110 },
  { prop: 'overdue_label', label: '超时档', type: 'tag', width: 96, options: [{ value: '正常', label: '正常', type: 'success' }, { value: '接近超时', label: '接近超时', type: 'warning' }, { value: '已超时', label: '已超时', type: 'danger' }] },
  { prop: 'dwell_text', label: '停留/超时线', width: 130 },
  { prop: 'owner_text', label: '负责人', width: 100 },
  { prop: 'registered_name', label: '登记者', width: 100 },
  { prop: 'shop_name', label: '测试店铺', width: 140 },
  { prop: 'source', label: '来源', width: 106 },
  { prop: 'supplier', label: '供应商', minWidth: 130 },
  { prop: 'category', label: '类目', width: 120 },
  { prop: 'purchase_price', label: '采购价', type: 'money', width: 104 },
  { prop: 'est_margin_pct', label: '预估毛利率', type: 'percent', width: 110 },
  { prop: 'breakeven_roas', label: '盈亏平衡 ROAS', width: 132 },
  { prop: 'conclusion', label: '测试结论', type: 'tag', options: CONCLUSION_OPTIONS, width: 120 },
  ...testMetricCols,
  { prop: 'gmv_text', label: '测试 GMV', width: 116, align: 'right' },
  { prop: 'checklist_text', label: '准备清单', width: 100 },
  { prop: 'spu_text', label: '关联 SPU', width: 110 },
  { prop: 'remark', label: '备注', minWidth: 160 },
]);

const deadColumns = computed<ColumnDef[]>(() => [
  { prop: 'code', label: '候选品 ID', width: 130, fixed: 'left' },
  { prop: 'name', label: '品名', minWidth: 170 },
  { prop: 'reject_text', label: '淘汰原因', minWidth: 240 },
  { prop: 'conclusion', label: '最后结论', type: 'tag', options: CONCLUSION_OPTIONS, width: 130 },
  { prop: 'source', label: '来源', width: 106 },
  { prop: 'supplier', label: '供应商', minWidth: 130 },
  { prop: 'owner_text', label: '最后负责人', width: 110 },
  { prop: 'registered_name', label: '登记者', width: 100 },
  { prop: 'purchase_price', label: '采购价', type: 'money', width: 104 },
  ...testMetricCols,
  { prop: 'gmv_text', label: '测试 GMV', width: 116, align: 'right' },
  { prop: 'stage_entered_at', label: '进池时间', type: 'datetime', width: 150 },
]);

onMounted(async () => {
  await Promise.all([loadShops(), loadOwners()]);
  await reloadAll();
});
</script>

<style scoped>
.page {
  padding: 16px;
}
.page-card {
  margin-bottom: 16px;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.toolbar-right {
  display: flex;
  gap: 8px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.title {
  font-size: 15px;
  font-weight: 600;
  margin-right: 8px;
}
.tip {
  color: #909399;
  font-size: 12px;
  line-height: 1.6;
}
.summary {
  font-size: 13px;
  color: #606266;
}
.summary b {
  color: #303133;
}
.sep {
  color: #dcdfe6;
  margin: 0 4px;
}
.funnel {
  display: flex;
  gap: 12px;
  align-items: stretch;
  min-height: 74px;
  flex-wrap: wrap;
}
.fstep {
  flex: 1 1 170px;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 6px 10px;
  background: #fff;
}
.frow {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 13px;
}
.flabel {
  color: #606266;
}
.fvalue {
  font-size: 19px;
  font-weight: 600;
}
.fbar {
  height: 6px;
  background: #f0f2f5;
  border-radius: 3px;
  margin: 6px 0 4px;
  overflow: hidden;
}
.fbar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #409eff, #79bbff);
}
.frate {
  font-size: 12px;
  color: #909399;
}
.levels {
  margin-top: 6px;
}
.board {
  display: grid;
  grid-template-columns: repeat(5, minmax(228px, 1fr));
  gap: 10px;
  overflow-x: auto;
  align-items: start;
}
.col :deep(.el-card__header) {
  padding: 8px 10px;
  background: #fafafa;
}
.col :deep(.el-card__body) {
  padding: 8px;
}
.col-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.col-title {
  font-size: 13px;
  font-weight: 600;
}
/* 卡片左边框三档：颜色直接取后端 overdue_level，前端不复算阈值 */
.scard {
  border: 1px solid #ebeef5;
  border-left: 4px solid #dcdfe6;
  border-radius: 4px;
  padding: 6px 8px;
  margin-bottom: 8px;
  background: #fff;
}
.scard:last-child {
  margin-bottom: 0;
}
.lv-ok {
  border-left-color: #67c23a;
}
.lv-warn {
  border-left-color: #e6a23c;
  background: #fdf6ec;
}
.lv-over {
  border-left-color: #f56c6c;
  background: #fef0f0;
}
.srow {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.code {
  font-family: Consolas, Menlo, monospace;
  font-size: 12px;
  color: #409eff;
}
.sname {
  font-size: 13px;
  font-weight: 600;
  margin: 3px 0;
  word-break: break-all;
}
.smeta {
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
}
.smetrics {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #303133;
  margin-top: 3px;
}
.sacts {
  margin-top: 4px;
  border-top: 1px dashed #f0f2f5;
  padding-top: 2px;
}
.sacts :deep(.el-button) {
  margin-left: 0;
  margin-right: 6px;
}
.ml4 {
  margin-left: 4px;
}
@media (max-width: 1400px) {
  .board {
    grid-template-columns: repeat(5, 260px);
  }
}
</style>
