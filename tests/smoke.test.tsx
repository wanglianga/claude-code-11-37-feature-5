import { describe, expect, it, vi } from 'vitest';

// node 环境下为 zustand persist 提供最小 localStorage 桩
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

describe('应用页面 SSR 冒烟（全部路由均可完整渲染）', () => {
  // 首次动态导入包含 echarts 大模块，转换较慢，单独放宽超时
  vi.setConfig({ testTimeout: 20000 });
  // react-router 在服务端渲染下会发出 useLayoutEffect 良性警告，与本应用正确性无关
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const paths = ['/', '/runs', '/report', '/evaluation', '/review', '/budget', '/share'];
  for (const path of paths) {
    it(`路由 ${path} 渲染不抛错并包含品牌标识`, async () => {
      const { renderToString } = await import('react-dom/server');
      const { MemoryRouter } = await import('react-router-dom');
      const { default: App } = await import('@/App');
      const html = renderToString(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );
      expect(html).toContain('渠道归因工作台');
      expect(html.length).toBeGreaterThan(500);
    });
  }
});
