import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const apiGet = vi.fn();
const warning = vi.fn();

vi.mock('@/api/client', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  errMsg: (e: unknown) => String((e as { message?: string })?.message ?? e),
}));
vi.mock('element-plus', () => ({ ElMessage: { warning: (...a: unknown[]) => warning(...a) } }));

const { useDictStore } = await import('@/stores/dict');

/**
 * 下拉选项「静默变空」的回归（审验轮 #31 的一项）。
 *
 * 界面显示「暂无数据」而接口其实挂了，用户和排障的人都分不出这两种情况 ——
 * 本项目真的因此白排查过一轮。所以这里钉住：失败必须说一次，而且只能说一次。
 */
describe('字典/店铺选项加载失败', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    apiGet.mockReset();
    warning.mockReset();
  });

  it('接口失败时返回空数组，并明确提示这是接口问题', async () => {
    apiGet.mockRejectedValueOnce(new Error('500 服务端错误'));
    const dict = useDictStore();
    expect(await dict.dict('order_status')).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);
    const text = String(warning.mock.calls[0][0]);
    expect(text).toContain('order_status');
    expect(text).toContain('不是没有数据');
  });

  it('同一种失败只弹一次（一页五个下拉共用一个字典时不刷屏）', async () => {
    apiGet.mockRejectedValue(new Error('网络中断'));
    const dict = useDictStore();
    await dict.dict('region');
    await dict.dict('region');
    await dict.dict('region');
    expect(warning).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledTimes(3);
  });

  it('成功后走缓存，不再重复请求，也不弹提示', async () => {
    apiGet.mockResolvedValueOnce([{ dict_value: 'MY', dict_label: '马来西亚' }]);
    const dict = useDictStore();
    expect(await dict.dict('region')).toEqual([{ dict_value: 'MY', dict_label: '马来西亚' }]);
    expect(await dict.dict('region')).toEqual([{ dict_value: 'MY', dict_label: '马来西亚' }]);
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
  });

  it('店铺列表失败时同样报告，而不是让店铺筛选静默变空', async () => {
    apiGet.mockRejectedValueOnce(new Error('403 无权访问'));
    const dict = useDictStore();
    expect(await dict.shopOptions()).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(warning.mock.calls[0][0])).toContain('店铺列表');
  });
});
