/**
 * echarts 按需装配（docs/dev-options.md 选项 2）
 *
 * 原来每个页面 `import * as echarts from 'echarts'` 会把整套 echarts（含地图、关系图、主题、
 * 所有图表类型）拉进包里 —— 单这一块就 1.1MB。集中在这里注册，页面统一从本文件取 init：
 * 新增图表类型时只要在这里补一行，漏注册的表现是「图不画」而不是静默出错，浏览器走查能发现。
 *
 * 本轮 UI 优化按「画什么图需要哪些类型」逐条加，不图省事上全量：
 *   Funnel   —— 选品/建联的转化漏斗（四根柱子用 DOM 摆已经不行了：要显示相邻两级之比）
 *   Gauge    —— 盈亏平衡 ROAS、投产比这类"离红线还有多远"的表
 *   Heatmap  —— 周内×小时的成交热力，折线看不出这种周期性
 *   Calendar/VisualMap 是热力的配套；Title 是环形图圆心那个总数（漏注册时圆心就是空的）；
 *   MarkLine 用来在趋势图上画盈亏平衡线这种参考线。
 */
import { getInstanceByDom, init, use, type EChartsCoreOption, type EChartsType } from 'echarts/core';
import { BarChart, LineChart, PieChart, FunnelChart, GaugeChart, HeatmapChart } from 'echarts/charts';
import {
  CalendarComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

use([
  BarChart,
  LineChart,
  PieChart,
  FunnelChart,
  GaugeChart,
  HeatmapChart,
  CalendarComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export type ECharts = EChartsType;
export type ChartOption = EChartsCoreOption;
export { getInstanceByDom, init };
