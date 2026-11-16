import { describe, expect, it } from 'vitest';
import { RequestSeq } from '@/services/api';

describe('RequestSeq 请求序号守卫（防旧响应覆盖新条件）', () => {
  it('快速连续两次请求：先返回的旧请求被标记为 rejected，最新请求 accepted', async () => {
    const seq = new RequestSeq<number>();
    const first = seq.run(() => new Promise<number>((resolve) => setTimeout(() => resolve(1), 60)));
    const second = seq.run(() => new Promise<number>((resolve) => setTimeout(() => resolve(2), 10)));

    const r1 = await first;
    const r2 = await second;
    expect(r1.accepted).toBe(false); // 旧响应：必须丢弃
    expect(r1.data).toBe(1);
    expect(r2.accepted).toBe(true); // 新条件响应：允许落库
    expect(r2.data).toBe(2);
  });

  it('无并发时单次请求正常 accepted', async () => {
    const seq = new RequestSeq<string>();
    const r = await seq.run(() => Promise.resolve('only'));
    expect(r.accepted).toBe(true);
    expect(r.data).toBe('only');
  });
});
