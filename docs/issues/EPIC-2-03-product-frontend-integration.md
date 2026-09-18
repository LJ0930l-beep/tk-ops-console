---
number: 7
epic: E2
title: 商品中心四页前端联调
labels: [frontend, product, phase-1]
blocked-by: [EPIC-2-01, EPIC-2-02]
estimate: 1.5d
---

## 背景

`apps/web/src/views/product/` 下 `SpuList.vue / SkuList.vue / ListingList.vue / UnmappedList.vue` 四个文件已存在（并行开发产出），但从未对照 PRD §3.3 的"列表列 / 筛选项 / 表单字段与校验 / 按钮与权限 / 空状态与告警"逐项核过；同时全站 `ResourcePage.vue` 已具备 `columns/searchFields/formFields/extraQuery/slots.actions/rowClassName/mapRow/beforeSubmit` 能力，页面里若还有手写 `el-table` 属于重复实现（评审要点 9）。

## 具体任务

1. 四页统一改用 `ResourcePage`（`api`/`title`/`columns`/`searchFields`/`formFields` 与 PRD §3.3 字段一一对应），保留已有特殊交互用 `slots` 实现：
   - SPU：`sku_count` 列、`main_image` 缩略图（`slot`）、删除按钮的 400 文案透出。
   - SKU：`money` 类型列（`purchase_cost/first_leg_cost/unit_cost`）、`cost_missing` 筛选、行内"改价"入口弹确认框展示 `EPIC-2-01` 返回的 `impact`。
   - Listing：`map_status=2` 行 `rowClassName` 返回 warning；`listing_status=5` 红角标；工具栏放「自动匹配」（带 `mapping/preview` 结果预览表）与「导入模板」；`ExportButton`（`EPIC-1-02`）。
   - Unmapped：两个 Tab 共用 `GET /api/products/unmapped`；页顶常驻 `summary.rows` 与 `gmv_cny_no_cost` 提示；每行「去绑定」调 `openEdit`。
2. 字典与店铺下拉：`dictType` 走 `category`，店铺筛选统一 `apiGet('/shops/mine')`（不许 `/shops/all`，见 `EPIC-1-03`）。
3. 掩码列渲染：值为字符串 `'***'` 时渲染灰色 `mask` 样式 + 列头锁形图标 tooltip「需成本权限」；确认 `ResourcePage` 已有 `cell(row,c)==='***'` 分支被用上，缺的部分在本工单补组件而不是每页复制。
4. 表单校验与后端 zod 对齐（长度、必填、数字范围），错误消息直接用后端 `message`（`errMsg(e)`），不做二次翻译。
5. 空态：四页各写一条 `el-empty` 文案 + 引导按钮（SPU→导入；SKU→新增；Listing→去同步；Unmapped→全部已映射）。

## 涉及文件

- 改：`apps/web/src/views/product/*.vue`（4 个）、`apps/web/src/router/index.ts`（4 条路由的 `meta.menu/perm`）
- 参考：`apps/web/src/components/ResourcePage.vue`（props 与 slots）、`apps/web/src/stores/dict.ts`、`apps/web/src/api/client.ts`

## 接口契约

复用 `EPIC-2-01/02` 已定契约；本页不得新增字段语义。

## 验收标准

- [ ] 以 `boss` 登录：四页列表/筛选/排序/分页均可用，`unit_cost` 与 `purchase_cost+first_leg_cost` 显示一致（两位小数）。
- [ ] 以 `limy` 登录：三个成本列显示 `***`（灰色），改价入口不渲染，`PUT` 直连 403 有 `ElMessage` 提示。
- [ ] Listing 页 `map_status=2` 行整行 warning 底色，工具栏计数与 `/unmapped` 页顶一致。
- [ ] 自动匹配预览框显示 `matched/ambiguous/skipped` 三档，确认后列表刷新。
- [ ] 四页无手写 `el-table`/`el-pagination` 重复代码（`grep -c "<el-table" views/product/*.vue` 仅出现在特殊区块）。
- [ ] 1280px 宽度下无横向滚动条溢出（`show-overflow-tooltip` 生效）。

## 测试要求

`apps/web/tests/unit/product.spec.ts`：`ResourcePage` 对 `'***'` 的渲染、`money` 列两位小数、`rowClassName` warning、`formFields.when` 条件字段；后端交互用 `vi.mock('@/api/client')`。
