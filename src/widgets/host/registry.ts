// src/widgets/host/registry.ts
// Реестр виджетов (D-070). В MVP — статическая хардкод-мапа id -> WidgetDef.
// Динамической загрузки плагинов нет; добавить виджет = строка здесь + импорт.
//
// App.tsx и WidgetHost про конкретные виджеты НЕ знают — только через реестр.
// Связь односторонняя: плагин знает про types.ts, реестр про плагин; обратно нет.
//
// Порядок: ядро НЕ полагается на порядок ключей мапы — сортировка идёт по
// manifest.order (см. listWidgets). Ключ мапы обязан совпадать с manifest.id.

import type { WidgetDef } from './types';
import { contextMeter } from '../context-meter';
import { compressor } from '../compressor';
import { tagger } from '../tagger';
import { saveDialog } from '../save-dialog';
import { openrouter } from '../openrouter';
import { gemini } from '../gemini';
import { tree } from '../tree';

// Гетерогенность State: у каждого виджета свой тип состояния (светофор — null,
// сжатие — мастер выбора диапазона). Хранить их в одной мапе строго типобезопасно
// нельзя — это законный случай для WidgetDef<unknown>. Граница типобезопасности
// проходит ВНУТРИ каждого WidgetDef (initialState/view/update согласованы по
// своему State через дженерик в types.ts); снаружи, на уровне коллекции, State
// стирается. WidgetHost<State> восстанавливает конкретику в точке использования.
// Поэтому здесь WidgetDef<unknown>, а НЕ any — any протёк бы внутрь и убил
// проверку внутри виджета.
type AnyWidgetDef = WidgetDef<unknown>;

// Единственный источник правды о составе. Ключ === manifest.id.
const WIDGETS: Record<string, AnyWidgetDef> = {
  [openrouter.manifest.id]: openrouter as AnyWidgetDef,
  [gemini.manifest.id]: gemini as AnyWidgetDef,
  [contextMeter.manifest.id]: contextMeter as AnyWidgetDef,
  [compressor.manifest.id]: compressor as AnyWidgetDef,
  [tagger.manifest.id]: tagger as AnyWidgetDef,
  [saveDialog.manifest.id]: saveDialog as AnyWidgetDef,
  [tree.manifest.id]: tree as AnyWidgetDef,
};

// Инвариант ключ===id: ловим рассинхрон на старте, а не молчим.
// (Дёшево, разовый проход; защищает от опечатки в ключе мапы.)
for (const [key, def] of Object.entries(WIDGETS)) {
  if (key !== def.manifest.id) {
    throw new Error(
      `registry: ключ "${key}" не совпадает с manifest.id "${def.manifest.id}"`,
    );
  }
}

/** Один виджет по id (или undefined). */
export function getWidget(id: string): AnyWidgetDef | undefined {
  return WIDGETS[id];
}

/**
 * Все виджеты в порядке отрисовки: по manifest.order (возр.), затем по id для
 * стабильности при равных order. Порядок ключей объекта здесь НЕ используется.
 */
export function listWidgets(): AnyWidgetDef[] {
  return Object.values(WIDGETS).sort((a, b) => {
    const oa = a.manifest.order ?? Number.MAX_SAFE_INTEGER;
    const ob = b.manifest.order ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a.manifest.id.localeCompare(b.manifest.id);
  });
}