// 图表统一配色（品牌中性色板，顺序色用于渠道分类）
export const CHART_COLORS = ['#2f54eb', '#13a8a8', '#722ed1', '#fa8c16', '#52c41a', '#eb2f96', '#faad14', '#2f54eb'];

export const CHART_TEXT = '#5b6675';
export const CHART_AXIS = '#e4e8ef';

export const baseTextStyle = { color: CHART_TEXT, fontSize: 12 };

export function barGrid() {
  return { left: 56, right: 24, top: 40, bottom: 40 };
}

export function tooltipYuan() {
  return {
    trigger: 'axis',
    axisPointer: { type: 'shadow' },
    valueFormatter: (v: unknown) => `¥${Number(v).toLocaleString('zh-CN')}`,
  };
}
