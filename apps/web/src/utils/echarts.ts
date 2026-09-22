/**
 * echarts 按需装配（docs/dev-options.md 选项 2）
 *
 * 全站只画三种图（折线/柱状/饼），但原来每个页面 `import * as echarts from 'echarts'`
 * 会把整套 echarts（含地图、关系图、主题、所有图表类型）拉进包里 —— 单这一块就 1.1MB。
 * 集中在这里注册，页面统一从本文件取 init：新增图表类型时只要在这里补一行，
 * 漏注册的表现是「图不画」而不是静默出错，浏览器走查能发现。
 */
import { init, use, type EChartsType } from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export type ECharts = EChartsType;
export { init };
