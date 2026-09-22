<template>
  <!-- 语言包只能在根上给一次：以前靠 app.use(ElementPlus, { locale })，
       现在组件是按需引入的，改成 el-config-provider 包裹，中文文案与分页/日期标签才不会变回英文 -->
  <el-config-provider :locale="zhCn">
    <router-view />
  </el-config-provider>
</template>

<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn';
</script>
