import type { NodeView } from '../host/types';

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function markerTag(label: string | null, comment: string | null): string {
  const l = label ?? '?';
  return comment ? `${l} : ${comment}` : l;
}

/** Полный транскрипт диапазона для LLM. range[0] (верхний A) не входит (D-063). */
export function buildTranscript(
  range: NodeView[],
  start: { label: string | null; comment: string | null },
  end: { label: string | null; comment: string | null },
): string {
  const body = range
    .slice(1)
    .filter(
      (n) => n.nodeType === 'user_message' || n.nodeType === 'assistant_message',
    );

  const lines = body.map((n) => {
    const who = n.nodeType === 'user_message' ? 'В' : 'О';
    return `${who}: ${n.text}`;
  });

  const head =
    `[Фрагмент: ${body.length} сообщ. ` +
    `Начало «${markerTag(start.label, start.comment)}», ` +
    `Конец «${markerTag(end.label, end.comment)}»]`;

  return `${head}\n\n${lines.join('\n\n')}`;
}

/** Оценка объёма для отладки в UI (символы). */
export function transcriptStats(text: string): { chars: number; messages: number } {
  const messages = (text.match(/^В:|^О:/gm) ?? []).length;
  return { chars: text.length, messages };
}

export { oneLine, markerTag };
