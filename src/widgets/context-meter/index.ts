// src/widgets/context-meter/index.ts
// Светофор объёма (D-009/D-011) — первый живой WidgetDef.
// ЧИСТЫЙ view на фактах: без капабилити, без update-логики.
//
// Оценка токенов — ПОЛИТИКА ПЛАГИНА, не ядра. Ядро даёт контент ветки и окно;
// токены плагин прикидывает сам. Здесь — грубая символьная оценка по классам:
// ASCII дешевле (≈4 симв/токен), не-ASCII (кириллица/CJK) дороже (≈2 симв/токен).
// Это ПРИБЛИЖЕНИЕ (D-011): точного локального токенайзера для Claude/OpenRouter нет.
// Кто хочет точный счёт (tiktoken для OpenAI, count-tokens API для Anthropic) —
// пишет свой плагин-светофор и ставит вместо этого. Веса и окно — параметры
// модели, в MVP константы; со слоем ролей (v0.2) переедут в реестр моделей.

import type {
  WidgetDef,
  WidgetFacts,
  WidgetMsg,
  ControlNode,
  NodeView,
} from '../host/types';

type State = null;

// Параметры модели (TODO: реестр моделей, v0.2). Сейчас под claude-haiku-4-5: окно 200k.
const WINDOW_FALLBACK = 200000;
const CHARS_PER_TOKEN_ASCII = 4;
const CHARS_PER_TOKEN_NONASCII = 2;

// Какие узлы реально уходят в модель и считаются в объём.
function countsTowardContext(nodeType: string): boolean {
  return (
    nodeType === 'user_message' ||
    nodeType === 'assistant_message' ||
    nodeType === 'compressed_summary'
  );
}

// Грубая оценка токенов строки по классам символов (по кодовым точкам, не UTF-16).
function estimateTokens(text: string): number {
  let ascii = 0;
  let nonascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 128) ascii++;
    else nonascii++;
  }
  return ascii / CHARS_PER_TOKEN_ASCII + nonascii / CHARS_PER_TOKEN_NONASCII;
}

// Индекс границы просмотра в ветке: узел с visibleBoundaryNodeId, иначе последний.
function boundaryIndex(branch: NodeView[], boundaryId: string | null): number {
  if (boundaryId) {
    const i = branch.findIndex((n) => n.id === boundaryId);
    if (i >= 0) return i;
  }
  return branch.length - 1;
}

// Цветовой слот по порогам (concept v5): <40 ок, 40–70 warn, 70–90 high, ≥90 crit.
function colorSlot(pct: number): string {
  if (pct >= 90) return 'var(--meter-crit)';
  if (pct >= 70) return 'var(--meter-high)';
  if (pct >= 40) return 'var(--meter-warn)';
  return 'var(--meter-ok)';
}

function fmt(n: number): string {
  const r = Math.round(n);
  return r >= 1000 ? `${(r / 1000).toFixed(1)}k` : String(r);
}

export const contextMeter: WidgetDef<State> = {
  manifest: {
    id: 'context-meter',
    title: 'Контекст',
    icon: 'gauge',
    defaultOpen: true,
    order: 10,
    surface: 'panel',
    capabilities: [], // ничего не трогает — только читает факты (disclosure, D-073)
    author: 'core',
    version: '0.1.0',
  },

  initialState(): State {
    return null;
  },

  view(_state: State, facts: WidgetFacts): ControlNode {
    const window =
      facts.context.window > 0 ? facts.context.window : WINDOW_FALLBACK;

    if (!facts.activeDialogId || facts.activeBranch.length === 0) {
      return {
        kind: 'stack',
        children: [{ kind: 'text', tone: 'muted', value: 'Нет активной беседы' }],
      };
    }

    const end = boundaryIndex(facts.activeBranch, facts.visibleBoundaryNodeId);

    // Сумма оценки токенов от корня до границы просмотра включительно.
    // MVP: пересчёт на каждый показ (показ редкий — по затиханию скролла).
    // TODO: накопительные суммы (префиксы) как оптимизация — наши «заготовки».
    let tokens = 0;
    for (let i = 0; i <= end; i++) {
      const n: NodeView = facts.activeBranch[i];
      if (countsTowardContext(n.nodeType)) tokens += estimateTokens(n.text);
    }

    const pct = Math.min((tokens / window) * 100, 100);

    return {
      kind: 'stack',
      children: [
        {
          kind: 'indicator',
          value: tokens,
          max: window,
          color: colorSlot(pct),
          label: `${pct.toFixed(0)}%`,
        },
        {
          kind: 'text',
          tone: 'muted',
          value: `≈ ${fmt(tokens)} / ${fmt(window)} токенов`,
        },
      ],
    };
  },

  update(_msg: WidgetMsg, state: State): State {
    return state;
  },
};