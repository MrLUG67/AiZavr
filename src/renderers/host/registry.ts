// src/renderers/host/registry.ts
// Реестр подсистемы рендеринга (как widgets/host/registry.ts: статическая хардкод-
// мапа в MVP; динамической загрузки плагинов нет). Добавить рендерер/парсер =
// импорт + строка в соответствующем массиве. DialogView про конкретные рендереры
// НЕ знает — только через этот реестр (связь односторонняя).
//
// Выбор:
//   pickParser          — первый ПАРСЕР, применимый к активной модели (по order);
//                         базовый ('*', order 1000) — гарантированный фолбэк.
//   pickSegmentRenderer — первый РЕНДЕРЕР, применимый к модели И matches(segment);
//                         базовые (по виду сегмента, order 1000) — фолбэк.
// Спец-плагины (с меньшим order и узким supportedModels/matches) перехватывают
// раньше базовых, ДОПОЛНЯЯ их, не трогая базовый UI.

import type {
  ContentParser,
  RenderFacts,
  Segment,
  SegmentRenderer,
} from './types';
import { modelApplicable } from './modelApplicable';
import { baseParser } from '../base/parser';
import { baseSegmentRenderers } from '../base/segments';

// Спец-парсеры (LLM-специфичная разметка) добавляются СЮДА, выше базового.
const PARSERS: ContentParser[] = [
  baseParser,
];

// Спец-рендереры сегментов (подсветка языка и т.п.) добавляются СЮДА, выше базовых.
const SEGMENT_RENDERERS: SegmentRenderer[] = [
  ...baseSegmentRenderers,
];

function byOrder<T extends { manifest: { order?: number; id: string } }>(
  list: T[],
): T[] {
  return [...list].sort((a, b) => {
    const oa = a.manifest.order ?? Number.MAX_SAFE_INTEGER;
    const ob = b.manifest.order ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a.manifest.id.localeCompare(b.manifest.id);
  });
}

export function pickParser(facts: RenderFacts): ContentParser {
  const sorted = byOrder(PARSERS);
  const hit = sorted.find((p) =>
    modelApplicable(p.manifest.supportedModels, facts.model.id),
  );
  return hit ?? baseParser;
}

export function pickSegmentRenderer(
  segment: Segment,
  facts: RenderFacts,
): SegmentRenderer | undefined {
  const sorted = byOrder(SEGMENT_RENDERERS);
  return sorted.find(
    (r) =>
      modelApplicable(r.manifest.supportedModels, facts.model.id) &&
      r.matches(segment, facts),
  );
}
