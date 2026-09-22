# TikTok real 模式：字段映射与真实店铺联调清单

对应 `docs/dev-options.md` 选项 10（任务 #42）。**现状：real 模式从未与真实店铺联调**，
本文件的对拍台是「有授权那天能立刻验」的前置设施：录制的平台报文 + 注入式桩传输，全程离线。

| 件 | 位置 |
| --- | --- |
| 录制的报文 | `apps/server/tests/fixtures/tiktok-real/{twin-orders,twin-products,twin-returns,twin-affiliate,manifest}.json` |
| 对拍台（桩传输 / 快照 / 两家同构店铺） | `apps/server/tests/realModeHarness.ts` |
| 录制器（mock 方言 → 平台方言，改 mockProvider 后才需要跑） | `apps/server/tests/realModeRecorder.ts` |
| 用例 | `apps/server/tests/real-mode.spec.ts` |
| 真实客户端 / 报文声明 / 归一化 | `apps/server/src/services/tiktok/{realClient,types,normalize}.ts` |
| 落库（mock 与 real 共用同一套 upsert） | `apps/server/src/jobs/syncJobs.ts` |

跑法：

```bash
cd apps/server
npx vitest run tests/real-mode.spec.ts             # 离线对拍，CI 每次都跑
npx vitest run tests/real-mode.spec.ts -t 真实店铺联调   # 缺 TT_APP_KEY/TT_APP_SECRET 时是 0 条执行
```

---

## 1. 字段映射

「归一化输入」= `types.ts` 声明的 `Platform*` 字段 + `syncJobs.ts` 实际读的表达式；
「DB 列」= 最终落库的列。**所有金额列都是主单位 REAL（两位小数），所有时间列都是 UTC 文本 `YYYY-MM-DD HH:MM:SS`。**

### 1.1 订单 `POST /order/202309/orders/search`

| TikTok real 报文字段 | 我们的归一化输入 | DB 列 | mock 报文来源 |
| --- | --- | --- | --- |
| `data.orders[].order_id`（平台实际是 `id`，见 D1） | `String(order_id).trim()` | `tk_order.tk_order_id` | `MOCK{店铺}{窗口}A1/B2/C3/D4` |
| `status` | `normalizeOrderStatus(status ?? sub_status)` | `order_status` | 直接给 `TO_BE_SHIPPED` / `COMPLETED` |
| `sub_status`（平台是 `substatus`，见 D1） | 同上兜底；空 → `ON_HOLD` | — | 不发 |
| `create_time`（Unix 秒） | `unixToUtc` | `order_time` | `utcToUnix(窗口内时间点)` |
| `payment_time` | `unixToUtc` | `paid_time` | 同 `create_time` |
| `ship_time`（0 = 无该节点） | `unixToUtc` → NULL | `ship_time` | 样品单给支付时间，其余 0 |
| `buyer_user_info.country`（平台是 `country_id`，见 D2） | `String().slice(0, 8)` | `buyer_region` | `shop.region` |
| `currency` | `slice(0, 3).toUpperCase()`，空 → `USD` | `currency` | `shop.currency` |
| `products_amount` = Money 对象 | `money()` | `subtotal` | 明细 `price × quantity` 合计（裸数字） |
| `seller_discount`，缺失时退 `discount_amount` | `money()` | `seller_discount` | 明细优惠合计 |
| `platform_discount` | `money()` | `platform_discount` | 恒 0 |
| `shipping_fee` | `money()` | `shipping_fee` | 0 或 2–9 |
| `total_amount`，缺失时算 `小计 − 卖家优惠 + 运费` | `money() \|\| round2(...)` | `total_paid` | 同式计算 |
| `fulfillment_type`（文本枚举，老版本给 1/2/3） | `normalizeFulfillment` | `fulfillment_type` 1平台仓/2自发货/3海外仓 | 新单给文本，「状态推进」单给数字 |
| `tracking_info.tracking_no`（平台在 `packages[]` 里，见 D4） | `slice(0, 64)` | `tracking_no` | 样品单 `tracking_info` |
| `tracking_info.courier_name`（对象 `{name}` 或字符串）`?? carrier` | `slice(0, 64)` | `carrier` | `{ name: 'J&T Express' }` |
| `is_sample_order`（布尔）`?? order_type` 含 `SAMPLE` | `flag()` | `is_sample_order` | 0/1 + `SAMPLE_ORDER` |
| `items[].sku_id` | `resolveItemSku` 第一优先（`shop_listing.tk_sku_id`） | `tk_order_item.listing_id → sku_id` | `listing.tk_sku_id` |
| `items[].seller_sku` | `resolveItemSku` 兜底匹配 | 同上 | `listing.seller_sku` |
| `items[].price` = Money 对象 | `money()` | `unit_price` | 裸数字 |
| `items[].quantity` | `max(1, Number ?? 1)` | `quantity` | 1–2 |
| `items[].seller_discount`，缺失时退 `item_discount` | `money()` | `discount` / `item_amount = 单价×数量−优惠` | 裸数字 |
| `items[].id` | 不落库（只对账日志用） | — | `${order_id}${序号}` |
| 成本 | `cost_matched=1` 时冻结 `(采购+头程)×数量` | `cost_snapshot` / `cost_matched` | 同一套 `snapshotCost` |

### 1.2 平台商品（listing）`POST /product/202309/products/search`

| TikTok real 报文字段 | 我们的归一化输入 | DB 列 | mock 报文来源 |
| --- | --- | --- | --- |
| `data.products[].id`（`?? product_id`） | `String().trim()` | `shop_listing.tk_product_id` | `listing.tk_product_id` / `MOCK-PROD-*` |
| `skus[].id` | `String().trim()`，空则跳过该 SKU | `tk_sku_id`（唯一键 `shop_id+tk_sku_id`） | `listing.tk_sku_id` / `MOCK-SKU-*` |
| `skus[].seller_sku`（`?? sku_code`） | `matchSkuBySellerSku`：全等，或 `sku_code` 前缀且唯一命中 | `sku_id` + `map_status` 1已映射/2待映射 | 内部 `product_sku.sku_code` |
| `skus[].price` = Money 对象（`?? sale_price`） | `money()` | `sale_price` | Money 对象（金额是裸数字） |
| `skus[].status ?? products[].status` | `normalizeListingStatus` | `listing_status` 1草稿/2审核/3在售/4下架/5违规 | `ACTIVATED` |
| `title`（`?? product_name`） | `slice(0, 200)` | `product_name` | `listing.product_name` |
| `data.next_page_token` | `ProductPage.nextCursor` → 作业侧循环翻页 | — | 固定 `MOCK-P2` |
| `category_id` / `main_images` / `skus[].stock` / `update_time` | **无对应列，全部丢弃**（见 D8） | — | 同样带着，便于对拍 |

### 1.3 售后 `POST /return/202309/returns/search`

| TikTok real 报文字段 | 我们的归一化输入 | DB 列 | mock 报文来源 |
| --- | --- | --- | --- |
| `data.returns[].return_id` | `String().trim()`，空即抛「缺少 return_id」 | `tk_return.tk_return_id` | `MOCKRT-{店铺}-{窗口}-{i}` |
| `order_id` | 按 `tk_order.tk_order_id` 定位；跨店 / 位于回收站 → 拒绝 | `order_id` | 本店已有单号 |
| `item_id`（平台是**订单明细 ID**，见 D3） | 只认 `listing.tk_sku_id` 或本地明细行 ID | `tk_order_item_id` | 本地行 ID（所以从未暴露该分叉） |
| `return_type`（`?? type`） | `normalizeReturnType` | `return_type` 1仅退款/2退货退款 | `RETURN_AND_REFUND` / `ONLY_REFUND` |
| `reason`（`?? customer_service_reason`） | `slice(0, 200)` | `reason` | 三选一文案 |
| `refund_amount`（`?? return_amount`）= Money 对象 | `money()` | `refund_amount` | Money 对象 |
| `currency` | `slice(0, 3).toUpperCase()` | `currency` | 订单币种 |
| `status` | `String().toUpperCase()`，空 → `PROCESSING` | `status` | `COMPLETED` / `PROCESSING` |
| `apply_time ?? create_time ?? delivery_time` | `unixToUtc` | `apply_time` | 窗口内时间点 |
| `finish_time` | `unixToUtc`（0 → NULL） | `finish_time` | 窗口末 / 0 |
| `has_returned` | `flag()`（更新时仅在字段出现才写） | `is_restocked` | 布尔 |
| `return_qty` | **无对应列** | — | 1 |

### 1.4 联盟订单（带货归因）`POST /affiliate/202312/orders/search`

归因是**更新已有明细行**，不插新行；报文字段变了不会报错，只会静默把佣金算成 0。

| TikTok real 报文字段 | 我们的归一化输入 | DB 列 | mock 报文来源 |
| --- | --- | --- | --- |
| `data.affiliate_orders[].order_id`（真实结构是 `data.orders[].order_item_pairs[]`，见 D7） | `pickAttributionTarget` 按单号定位 | 定位 `tk_order_item` | 本店已有单号 |
| `sku_id` / `seller_sku` | 同上第二匹配键 | — | `listing.tk_sku_id` / `seller_sku` |
| `creator_handle` | `normalizeHandle`（去 `@`、小写）→ `creator.handle`，退 `tk_account.handle` | `creator_id`（自营号只进计数不落库） | `'@' + 大写 handle`，最后一条故意给不存在的 handle |
| `content_type` | `normalizeContentType(值, 是否达人)` | `content_type` 1达人视频/2达人直播/3自营视频/4自营直播/5商品卡 | `VIDEO` / `LIVE` |
| `video_id ?? live_id` | `String().trim() \|\| null` | `content_id` | `video.tk_video_id` |
| `seller_commission_rate ?? commission_rate` | `round2(Number ?? 0)` | `commission_rate` | 10/12/15/18 |
| — | `明细金额 × 费率 / 100` | `est_commission` | 同式 |
| `seller_commission_amount` | **不使用**（见 D8） | — | 裸数字 |
| `platform_commission_rate` / `creator_id` / `affiliate_creator_id` / `create_time` | 不使用 | — | — |

---

## 2. 已知分叉（对拍台已钉住，联调前必须逐条确认）

这些用例断言的是**当前现状**（都是绿的）。哪天映射修好了，用例会红 —— 那就是让你回来改这张表和本文件的入口。

| # | 现象 | 现在的后果 | 要做什么 | 用例 |
| --- | --- | --- | --- | --- |
| D1 | 平台订单主键是 `id`，我们只认 `order_id` | real 模式**一单都进不来**（`平台订单缺少 order_id`） | `PlatformOrder.id` + 映射兜底 `order_id ?? id`；`substatus` 同理 | `real-mode.spec.ts > D1` |
| D2 | `buyer_user_info` 给 `country_id` / `region_id` | `buyer_region` 落 NULL | 读值链上补 `country_id/region_id` | 同上 D2 |
| D3 | 售后 `item_id` 是平台订单明细 ID | `tk_order_item_id` 落 NULL，退款算不到具体行 | 明细行需要另存平台 `item_id` 才能对上 | 同上 D3 |
| D4 | 物流在 `packages[].tracking_info` | `carrier` / `tracking_no` 落 NULL | 支持从 `packages[]` 取第一条 | 同上 D4 |
| D5 | 部分接口时间是 ISO-8601 带偏移 | `order_time` 落 NULL（`unixToUtc` 只认 Unix 秒） | `unixToUtc` 或新增 `anyToUtc` 兼容文本时间 | 同上 D5 |
| D6 | 金额可能是「分」（minor units） | 按面值放大 100 倍入库（`money()` 刻意不猜尺度） | 只能靠币种/接口确认，不能靠数值猜 | 同上 D6 |
| D7 | 联盟报文是 `data.orders[].order_item_pairs[]` 嵌套 | 归因静默 0 条 → 报表佣金全 0 | `pageList` 增键 + 展平 `order_item_pairs` | 同上 D7 |
| D8 | 平台给了库存 / 主图 / 类目 / 佣金金额，本地没有列 | 数据丢弃（不是错误，但别指望界面上有） | 要么加列，要么在 PRD 里明确不接 | 同上 D8 |

另外两处**没进对拍**的既有事实：
- `syncJobs.syncListingsForShop` 的翻页循环有 20 页硬编码闸门（商品数 > 1000 会被截断），没走 `config`；
- 作业侧 `real` 模式下 `page_size` 仍是字面量（订单 100、其余 50），要按平台当期限流文档调时得改代码。

---

## 3. 凭证与令牌

| 项 | 口径 |
| --- | --- |
| `app_key` / `app_secret` | 每店一份，AES-GCM 密文存 `tk_shop.app_key_enc` / `app_secret_enc`；密钥是 `CRED_ENC_KEY`（`config.credKey`，非生产回退 `JWT_SECRET`）。**没有环境变量兜底**。 |
| `access_token` | **按店铺**存 `tk_shop.access_token_enc`。`buildShopCredential()` 只在内存里解出明文，real 模式缺 token 直接 `AppError 40020` 并写进 `sync_log`，绝不拿一个共享 token 打所有店。 |
| `shop_cipher` | 明文存 `tk_shop.shop_cipher`（它是路由参数不是密钥），随查询串下发；与 token 不匹配即平台 `code=101000`。 |
| 过期 | `tk_shop.token_expire_at` + `auth_status`（2 即将过期 / 3 已失效）；界面提示重新授权。 |
| 出口脱敏 | `realClient.safe()`：先把本店四类凭证整串替换成 `***`，再走 `core/redact.ts` 的 `maskError()`（`credential=值` 与 32 位以上长串），最后截 300 字符。`syncJobs` 落 `sync_log.error_msg` 前也过 `maskError()`；`/api/system/synclog/health` 读侧再掩一次（**列表接口 `/api/system/synclog` 只依赖写侧已脱敏**，改这条链路时别把写侧的 mask 去掉）。 |
| 红线 | `app_key` / `app_secret` / `access_token` / `sign` 不进日志、错误文案、响应体、测试报文。`real-mode.spec.ts` 里有一条用例扫遍 fixture 目录：出现 32 位以上疑似凭证串或凭证字段名即失败。 |

---

## 4. 签名（`/order|product|return|affiliate` 各 search 接口通用）

1. 查询参数剔除 `sign`、`access_token` 与空值，按 key 升序拼成 `key1value1key2value2…`（无 `=`、无 `&`）；
2. `base = path + 上述串 + 请求体原文`（无体时空串）；
3. `signed = app_secret + base + app_secret`；
4. `sign = hex(HMAC-SHA256(key = app_secret, signed))`，小写十六进制；
5. `app_key` / `timestamp`（秒，每次重试重取） / `shop_cipher` / `sign` 走查询串，token 走 `x-tts-access-token` 头；
6. 202309 的 search 系列是 **POST**：过滤条件在 JSON body，`page_size` / `page_token` 在查询串 —— body 只序列化一次，参与签名的字节必须与发出的字节完全一致。

官方契约没有 nonce，也没有 `x-tt-*` 私有头（`shop-auth.spec.ts` 反过来钉住了这点，并独立复算查询串里的 sign）。

---

## 5. 翻页与限流

| 项 | 口径 | 环境变量 |
| --- | --- | --- |
| 订单 / 售后 | 游标 `next_page_token` 循环，取空即停；上限 `config.tiktokMaxPages` | `TT_MAX_PAGES`（默认 50） |
| 商品 | 调用方（`syncJobs`）持游标循环，`ProductPage.nextCursor` 为空即停 | — |
| 联盟 | 一次请求，不翻页 | — |
| 请求超时 | `AbortSignal.timeout(config.tiktokTimeoutMs)` | `TT_HTTP_TIMEOUT_MS`（默认 15000） |
| 可重试 | HTTP 429 / 5xx、`code=36009002`（限流）、`36009004` 或 message 含 `overload` | `TT_MAX_RETRY`（默认 2） |
| 退避 | 有 `Retry-After` 就按它（封顶 5 秒），否则 `500ms × 次数` | — |
| 不可重试 | `105002` 令牌过期、`106001` 签名不通过、`101000` cipher 不匹配 —— 这三类是「改配置/重新授权」，多打只会白费额度 | — |
| 空结果告警 | 近 30 天该店有单、本次窗口拉到 0 条 → `sync_log.status=3` 并告警（接口静默返回空的兜底） | — |

---

## 6. 真实店铺联调 checklist

前提：一个已授权的真实店铺 + 平台后台已开通「订单 / 商品 / 售后 / 联盟」四类接口权限。**联调只做读操作**（不改价、不发货）。

1. 准备凭证（只进环境变量与店铺表，不进仓库）：
   ```bash
   export TIKTOK_API_MODE=real
   export TIKTOK_API_BASE=https://open-api.tiktokglobalshop.com   # 默认全局网关；是否要按站点换域名，联调时按平台指引确认
   export CRED_ENC_KEY=<32 位以上随机串>                           # 生产必填（凭证密文的 AES-GCM 密钥）
   # 店铺凭证走界面「店铺与账号 → 重新授权」写进 tk_shop 的三个 *_enc 列；
   # 只有联调冒烟用例用下面这组环境变量：
   export TT_APP_KEY=<app key> TT_APP_SECRET=<app secret> TT_ACCESS_TOKEN=<该店 token> TT_SHOP_CIPHER=<该店 cipher>
   ```
2. 先跑冒烟（`real-mode.spec.ts` 最后那个 `describe.skipIf` 块，只读商品接口，日志只打条数）：
   ```bash
   cd apps/server && npx vitest run tests/real-mode.spec.ts -t 真实店铺联调冒烟
   ```
   过了说明「签名 + token + 域名 + 翻页参数」这一层通了；报 106001 查 `TT_APP_SECRET`/站点，报 101000 查 `TT_SHOP_CIPHER`。
3. 手工对一次单店全量同步并核对数字：
   ```bash
   TIKTOK_API_MODE=real node --disable-warning=ExperimentalWarning dist/index.js   # 或 npm run dev
   # 界面：数据同步 → 选这家店 → 依次跑「商品 → 订单 → 售后 → 联盟」
   ```
   核对：`sync_log` 的 fetched/inserted/updated/failed、`tk_order` 金额与卖家中心一致、
   `tk_order_item.cost_matched=0` 的行是否只是没建档。
4. 把真实响应**换进对拍台**（这一步才是本次任务的正题）：
   - 抓一次真报文（只留必要字段、把凭证与买家信息删掉、金额时间保持原样）替换 `tests/fixtures/tiktok-real/*.json`；
   - 相应更新 `manifest.json` 里的 mock↔real 单号配对（或直接 `TT_RECORD_FIXTURES=1 npx vitest run tests/real-mode.spec.ts -t 重新录制` 重录一份 mock 侧基线，再把真报文并进来）；
   - 逐条销第 2 节的 D1…D8：改哪条、哪条用例会红、改完更新本文件的表。
5. 收工：`npm run lint -w @tk/server && npm run test -w @tk/server`。

桩传输与真实调用的切换点：`RealTikTokShopClient` 的第二个构造参数（`Transport`）。
默认 `globalThis.fetch`（真实出网），测试注入桩（完全离线，且 baseUrl 用永不解析的 `https://recorded.invalid`）。
业务代码一律经 `createTiktokClient()` 拿客户端，不直接 new —— 需要注入桩时用 `new RealTikTokShopClient(url, transport)`。

---

## 7. 没有真实店铺，仍然验证不了的东西

- **报文事实本身**：fixture 是按 `realClient.ts` 的请求侧与 `types.ts` 的声明写的，不是抓包来的。字段名、Money 的 amount 是主单位还是分、时间戳单位、翻页游标的真实形态（我们是当不透明串在传）都要联调当天确认。第 2 节的 D1…D7 就是这份「不确定」的清单。
- **站点差异**：美区 / 英区 / 东南亚的字段与枚举是否一致；`TIKTOK_API_BASE` 是否要按站点分域名（现在只有全局一个）。
- **权限面**：联盟卖家接口要单独申请，拿不到时归因永远 0 条 —— 目前只有告警文案提示，没有「权限未开通」这个状态位。
- **量级**：真实店铺的订单量下，`TT_MAX_PAGES × page_size` 与限流窗口够不够；一次同步的实际耗时。
- **授权与续期**：token 刷新回调（`auth_status` 2→3 的实际时序）从未被真报文驱动过；`token_expire_at` 的写入路径只在店铺界面里。
- **写操作**：本项目一期不做写接口（改价 / 发货 / 退款审批），real 客户端也只读 —— 这条边界是刻意设计的，别在联调时顺手加写调用。
