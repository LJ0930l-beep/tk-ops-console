import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from '@/router';
import '@/styles/main.css';

/**
 * 不再 `app.use(ElementPlus)` 全量注册、也不再 `import 'element-plus/dist/index.css'`
 * 与「把所有图标注册成全局组件」—— 那是首屏 1.26MB 的主要来源。
 * 组件/样式由 vite.config 里的 ElementPlusResolver + unplugin-element-plus 按需注入，
 * 图标一律在用到的文件里 `import { Xxx } from '@element-plus/icons-vue'`。
 */
createApp(App).use(createPinia()).use(router).mount('#app');
