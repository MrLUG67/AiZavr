// Опция «Метрика запросов» (меню Настройки). Глобальный флажок, общий для
// MenuBar (переключает) и DialogView (рисует строку под именем беседы).
// Паттерн как у i18n: значение в localStorage + подписчики + React-хук.

import { useEffect, useReducer } from "react";

const LS_KEY = "aizavr.metricsEnabled";

function read(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = read();
const listeners = new Set<() => void>();

export function getMetricsEnabled(): boolean {
  return enabled;
}

export function setMetricsEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  try {
    localStorage.setItem(LS_KEY, next ? "1" : "0");
  } catch {}
  listeners.forEach((fn) => fn());
}

export function toggleMetricsEnabled(): void {
  setMetricsEnabled(!enabled);
}

// Хук: подписывает компонент на смену флажка (перерисовка) и отдаёт текущее.
export function useMetricsEnabled(): boolean {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const fn = () => force();
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return enabled;
}
