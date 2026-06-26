// Общий сборщик транскрипта линейного диапазона для плагинов (компрессор,
// тегизатор). i18n-нейтрален: подписи (В:/О:, заголовок) передаются параметром
// `labels`, чтобы каждый плагин подставлял свои локализованные строки.

import type { NodeView } from '../host/types';

export function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function markerTag(label: string | null, comment: string | null): string {
  const l = label ?? '?';
  return comment ? `${l} : ${comment}` : l;
}

export interface MarkerRef {
  label: string | null;
  comment: string | null;
}

export interface TranscriptLabels {
  user: string; // напр. «В»
  assistant: string; // напр. «О»
  header(count: number, start: string, end: string): string;
}

/** Полный транскрипт диапазона для LLM. range[0] (верхний A) не входит (D-063). */
export function buildTranscript(
  range: NodeView[],
  start: MarkerRef,
  end: MarkerRef,
  labels: TranscriptLabels,
): string {
  const body = range
    .slice(1)
    .filter(
      (n) => n.nodeType === 'user_message' || n.nodeType === 'assistant_message',
    );

  const lines = body.map((n) => {
    const who = n.nodeType === 'user_message' ? labels.user : labels.assistant;
    return `${who}: ${n.text}`;
  });

  const head = labels.header(
    body.length,
    markerTag(start.label, start.comment),
    markerTag(end.label, end.comment),
  );

  return `${head}\n\n${lines.join('\n\n')}`;
}

/** Оценка объёма для отладки в UI (символы). */
export function transcriptStats(text: string): { chars: number; messages: number } {
  const messages = (text.match(/^(В|О|U|A):/gm) ?? []).length;
  return { chars: text.length, messages };
}
