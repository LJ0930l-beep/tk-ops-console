# TikTok 运营管理后台

TikTok Shop 多店铺 / 达人建联 / 短视频与直播 / 广告投放 / 利润核算 一体化运营后台。

详细需求见 docs/prd.md，开发规范见 docs/development-standards.md，Epic 拆分见 docs/epics.md。

后续可选的开发方向（限流、导出、契约生成、e2e、库迁移、任务队列、真实店铺联调等 12 项，含现状证据、做法、工作量与验收标准）见 **docs/dev-options.md**。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 同时起后端（:8787）与前端（:5173，代理 `/api`） |
| `npm run lint` | 后端 `tsc --noEmit` + 前端 `vue-tsc --noEmit` |
| `npm run test` | 后端 vitest（243 例）+ 前端单测 |
| `npm run smoke` | 全链路冒烟：内存库起真 HTTP 服务，8 角色 × 全部 GET + 写链路 + 导出 + 限流，退出码非 0 即有 FAIL |
| `npm run build` | 三个 workspace 依次构建 |
