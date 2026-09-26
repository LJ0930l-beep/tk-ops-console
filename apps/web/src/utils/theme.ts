/**
 * 把 CSS 令牌读给 echarts。
 *
 * 图里的文字、轴线、参考带这些颜色必须和卡片本身是一套，否则改一次主色要同时改 css 和五个
 * option 里的 hex —— 上一版就是这么散着的。echarts 不认 var(--x)，只能在运行时取值。
 * 取不到（单测里没有那份 css、或令牌被删了）就用 fallback，保证图不会因为没有颜色就画不出来。
 */
const cache = new Map<string, string>();

export function tk(name: string, fallback: string): string {
  const key = `--tk-${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const v =
    (typeof document !== 'undefined' ? getComputedStyle(document.documentElement).getPropertyValue(key).trim() : '') || fallback;
  cache.set(key, v);
  return v;
}

export const chartColor = {
  ink: () => tk('ink', '#303133'),
  muted: () => tk('muted', '#909399'),
  line: () => tk('line', '#ebeef5'),
  primary: () => tk('primary', '#409eff'),
  success: () => tk('success', '#67c23a'),
  warning: () => tk('warning', '#e6a23c'),
  danger: () => tk('danger', '#f56c6c'),
  money: () => tk('money', '#c45656'),
  faint: () => tk('faint', '#a8abb2'),
};

/**
 * 系统开了「减少动态效果」时，echarts 那份动画也要关掉 ——
 * CSS 里那条 media query 管不到 canvas 内部。
 * 每个 option 展开一次：`animation: reducedMotion() ? false : 600`。
 */
export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** 所有图共用的进场设置；放在一处，免得每张图各写一遍又各漏一遍 */
export function motion(): Record<string, unknown> {
  return reducedMotion() ? { animation: false } : { animationDuration: 600, animationEasing: 'cubicOut' };
}
