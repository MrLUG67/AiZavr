// Опция «Показывать без ответа» (меню Настройки). Глобальный флажок, общий для
// MenuBar (переключает) и useDialogController (фильтрует ленту).
// Паттерн как у metricsSetting: значение в localStorage + подписчики + хук.
//
// Смысл: ON — пустые пары Q+«ответ не получен» висят в ленте всегда (полезно для
// диагностики плагина/модели). OFF — такие пары скрываются, как только в ветке
// получен первый реальный ответ; «дырки» схлопываются. Дефолт OFF (чистая лента).

import { useEffect, useReducer } from "react";

const LS_KEY = "aizavr.showUnanswered";

function read(): boolean {
  try {
    // Дефолт OFF: показываем мусор только если пользователь явно включил ("1").
    return localStorage.getItem(LS_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = read();
const listeners = new Set<() => void>();

export function getShowUnanswered(): boolean {
  return enabled;
}

export function setShowUnanswered(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  try {
    localStorage.setItem(LS_KEY, next ? "1" : "0");
  } catch {}
  listeners.forEach((fn) => fn());
}

export function toggleShowUnanswered(): void {
  setShowUnanswered(!enabled);
}

// Хук: подписывает компонент на смену флажка (перерисовка) и отдаёт текущее.
export function useShowUnanswered(): boolean {
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
