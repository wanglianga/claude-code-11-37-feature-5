import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

interface EChartProps {
  option: echarts.EChartsOption;
  className?: string;
  /** 高度由 className 控制；切换 option 时做增量 setOption */
  merge?: boolean;
  /** 图形元素点击（如从渠道扇区下钻到该渠道的订单列表） */
  onClick?: (params: echarts.ECElementEvent) => void;
}

/** 统一的 ECharts 封装：自适应容器尺寸、卸载时销毁实例 */
export default function EChart({ option, className, merge = true, onClick }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const handler = (params: echarts.ECElementEvent) => clickRef.current?.(params);
    chart.on('click', handler);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.off('click', handler);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: !merge });
  }, [option, merge]);

  return <div ref={ref} className={className ?? 'chart-box'} role="img" />;
}
