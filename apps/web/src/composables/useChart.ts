import { nextTick, onActivated, onBeforeUnmount, onMounted, watch, type WatchSource } from 'vue';
import { getInstanceByDom, init, type ChartOption, type ECharts } from '@/utils/echarts';

/**
 * 图表生命周期收口。
 *
 * 在这之前三处图表各写一份 init / setOption / window resize / onActivated / dispose，
 * 每份都有同一个洞：只监听 window resize。折叠侧边栏、拉抽屉、开弹窗都会改容器宽度，
 * 而 window 尺寸没变 —— 表现是「图右侧空一截」或「图挤成一团」，且只在特定操作后出现，很容易漏测。
 *
 * 现在改成盯容器自身的 ResizeObserver，并且**没有尺寸就不 init**：
 * 卡片的空态会把 body 藏起来（display:none → clientHeight 0），
 * 那时 init 只会得到 echarts 一句「Can't get DOM width or height」并画出一张白图，
 * 等 ResizeObserver 看到真实尺寸再画。容器被 v-if 重建过的情况也在这里认 DOM 不认变量。
 */
export function useChart(
  el: { value?: HTMLElement } | undefined,
  build: () => ChartOption | null | undefined,
  deps: WatchSource[] = [],
): { render: () => Promise<void>; dispose: () => void } {
  let chart: ECharts | null = null;
  let observer: ResizeObserver | null = null;
  let watched: HTMLElement | null = null;

  const dispose = (): void => {
    chart?.dispose();
    chart = null;
  };

  async function render(): Promise<void> {
    await nextTick();
    const node = el?.value;
    if (!node) return;
    if (observer && node !== watched) {
      if (watched) observer.unobserve(watched);
      observer.observe(node);
      watched = node;
    }
    const sized = node.clientWidth > 0 && node.clientHeight > 0;
    if (!chart) {
      if (!sized) return;
      // 同一个 DOM 上可能已经有一个实例（热更新、或上一次的我没dispose干净）——
      // 再 init 一次 echarts 会静默留一个看不见的实例，这里选择认领而不是重复创建。
      chart = getInstanceByDom(node) ?? init(node);
    } else if (chart.getDom() !== node) {
      dispose();
      if (!sized) return;
      chart = init(node);
    }
    const option = build();
    if (option) chart.setOption(option, true);
  }

  onMounted(() => {
    observer = new ResizeObserver(() => {
      // 还没成图 → 这次尺寸变化就是"终于有尺寸了"的信号；已成图 → 只是宽度变了
      if (chart) chart.resize();
      else void render();
    });
    void render();
  });

  /** keep-alive 页面回来时容器宽度可能已经变了（侧边栏被折叠过），必须重算 */
  onActivated(() => void render());

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
    dispose();
  });

  if (deps.length) watch(deps, () => void render());

  return { render, dispose };
}
