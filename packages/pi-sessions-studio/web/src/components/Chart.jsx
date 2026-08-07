import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';

const BASE = {
  backgroundColor: 'transparent',
  textStyle: { color: 'var(--chart-text)', fontFamily: 'var(--sans)' },
  grid: { left: 8, right: 12, top: 30, bottom: 8, containLabel: true },
};

function resolveCssVars(value, styles) {
  if (Array.isArray(value)) return value.map((item) => resolveCssVars(item, styles));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveCssVars(item, styles)])
    );
  }
  if (typeof value !== 'string' || !value.includes('var(')) return value;
  return value.replace(
    /var\((--[\w-]+)(?:,\s*([^)]+))?\)/g,
    (match, name, fallback) => styles.getPropertyValue(name).trim() || fallback?.trim() || match
  );
}

export default function Chart({ option, height = 260, onClick }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  const [themeVersion, setThemeVersion] = useState(0);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, null, { renderer: 'canvas' });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const refresh = () => setThemeVersion((version) => version + 1);
    const observer = new MutationObserver(refresh);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    media.addEventListener('change', refresh);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', refresh);
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !option) return;
    const styles = getComputedStyle(document.documentElement);
    chart.setOption(resolveCssVars({ ...BASE, ...option }, styles), { notMerge: true });
    if (onClick) {
      chart.off('click');
      chart.on('click', onClick);
    }
  }, [option, onClick, themeVersion]);

  return <div ref={ref} style={{ width: '100%', height }} />;
}
