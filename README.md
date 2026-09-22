# TikTok 运营管理后台

TikTok Shop 多店铺 / 达人建联 / 短视频与直播 / 广告投放 / 利润核算 一体化运营后台。

详细需求见 docs/prd.md，开发规范见 docs/development-standards.md，Epic 拆分见 docs/epics.md。

后续可选的开发方向（限流、导出、契约生成、e2e、库迁移、任务队列、真实店铺联调等 12 项，含现状证据、做法、工作量与验收标准）见 **docs/dev-options.md**。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 同时起后端（:8787）与前端（:5173，代理 `/api`） |
| `npm run lint` | 后端 `tsc --noEmit` + 前端 `vue-tsc --noEmit` |
| `npm run test` | 后端 vitest（354 例，2 例外呼用例默认跳过）+ 前端单测（10 例） |
| `npm run smoke` | 全链路冒烟：内存库起真 HTTP 服务，8 角色 × 全部 GET + 写链路 + 导出 + 限流，退出码非 0 即有 FAIL |
| `npm run e2e` | Playwright 端到端 50 例：RBAC 可见性 / 导入中心 / 行动中心闭环 / 36 个页面逐个打开。自己起临时库与服务端，不碰 `apps/data/tk_ops.db` |
| `npm run openapi` | 重新生成 `docs/openapi.json` 与前端 `ApiPath` 路径类型；改了路由就得跑，CI 会检查生成物是否落后 |
| `npm run build` | 三个 workspace 依次构建 |

上面这些已经接进 CI：`.github/workflows/ci.yml` 的 `gates`（lint / test / build / smoke + 生成物与演示库未被写脏）与 `e2e`（Chromium）两条 job 并行跑。

## 一键启动

Windows 下直接双击仓库根目录的三个按钮，不需要先读文档：

| 双击 | 做什么 |
| --- | --- |
| `start.bat` | 装依赖（首次）→ 构建（首次）→ **单端口**起服务并自动开浏览器：<http://127.0.0.1:8787>。关窗口即停止 |
| `dev.bat` | 开发模式：后端 :8787 + 前端 :5173（vite 代理 `/api`），两边热更新 |
| `reset.bat` | 清掉 `runtime/`，复位演示数据（演示中把数据改乱了用这个） |

命令行等价：`node scripts/launch.mjs [start|dev|reset] [--build] [--no-open]`。

两点设计上的坚持：

- **不直接跑仓库里那份演示库**。`apps/data/tk_ops.db` 是 git 跟踪的固定夹具，SQLite 在 WAL 模式下起一次服务就会把它写脏；
  启动器把它复制成 `runtime/tk_ops.db` 再用，所以随便你怎么点，`git status` 都是干净的（CI 里也有一条 job 专门守这个）。
- **单端口不是新发明**：`serveWeb`（默认开）在后端顺带托管 `apps/web/dist`，接口路径永远优先，
  `/assets/*` 因为文件名带 content hash 所以给了 7 天强缓存，`index.html` 不缓存以免改版后卡在旧入口。

演示口令是种子数据里写死的 `Passw0rd!`（例如 `boss`），不是真实凭证；真要用真实 TikTok 店铺需按 `docs/tiktok-real-mode-mapping.md` 配 `TIKTOK_API_MODE=real` 与凭证。
