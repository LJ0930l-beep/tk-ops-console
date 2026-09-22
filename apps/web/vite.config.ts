import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import ElementPlus from 'unplugin-element-plus/vite';
import path from 'node:path';

/**
 * 构建期插件（首屏体积，见 docs/dev-options.md 选项 2）：
 *  - Components + ElementPlusResolver：模板里的 el-* 组件按需引入，样式跟着组件走；
 *  - ElementPlus：给**显式 import** 的 API（ElMessage / ElMessageBox / ElLoading 这类
 *    不是写在模板里、resolver 扫不到的用法）补样式，否则函数式组件会「有逻辑没样式」。
 */
export default defineConfig({
  plugins: [
    vue(),
    Components({ resolvers: [ElementPlusResolver({ importStyle: 'css' })], dts: 'src/components.d.ts' }),
    AutoImport({ resolvers: [ElementPlusResolver()], dts: 'src/auto-imports.d.ts' }),
    ElementPlus({ useSource: false }),
  ],
  resolve: { alias: { '@': path.resolve(__dirname, 'src'), '@tk/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts') } },
  server: {
    // 默认端口被别的进程占着时，e2e 可以用 WEB_PORT 换一条端口跑，不必抢人工 dev 的口子
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * 只强制两类分包，其余交给 rollup 自然切分：
         *  - echarts 必须单独成块且**不能进首屏**（只有看板 / ABC / 直播曲线三页用得到）；
         *  - vue 全家桶稳定，单独成块让业务改动不至于让用户重下框架；
         *  - element-plus 反过来不要塞进一个大 chunk：按组件切分时（el-date-picker、el-table …）
         *    首屏只要 178KB gzip；强行合成一个 vendor-element-plus 会变成 405KB，
         *    还会引出 vendor-misc ↔ vendor-vue 的循环 chunk 警告。
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/echarts/') || id.includes('/zrender/')) return 'vendor-echarts';
          if (id.includes('/@vue/') || id.includes('/vue-router/') || id.includes('/pinia/') || id.includes('/vue/')) return 'vendor-vue';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.spec.ts'],
    globals: true,
    /**
     * 按需引入之后，解析 .vue 会连带 import element-plus 的 *.css（resolver 注进来的），
     * vitest 默认 externalize node_modules，node 直接吃不下 .css 扩展名。
     * 让 element-plus 走 vite 转译 + 不真正处理样式，纯逻辑测试不依赖 CSS。
     */
    css: false,
    server: { deps: { inline: ['element-plus', /@element-plus/] } },
  },
} as any);
