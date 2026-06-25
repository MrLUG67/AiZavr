// src/renderers/MessageContent.tsx
// Точка интеграции подсистемы рендеринга в ленту: заменяет прежний голый
// <p>{content}</p> для ответов ассистента. Парсит ответ выбранным парсером,
// рисует каждый сегмент выбранным рендерером.
//
// Изоляция ошибок (как в WidgetHost, D-070/D-073): любой сбой парсера/рендерера
// не роняет ленту — откатываемся на голый текст (точно как было до подсистемы).
// Пузырь и базовый UI при этом не меняются.

import { Fragment, type ReactNode } from 'react';
import type { RenderFacts } from './host/types';
import { pickParser, pickSegmentRenderer } from './host/registry';

export function MessageContent({
  content,
  facts,
}: {
  content: string;
  facts: RenderFacts;
}): React.ReactElement {
  let nodes: ReactNode;
  try {
    const segments = pickParser(facts).parse(content, facts);
    nodes = segments.map((seg, i) => {
      try {
        const renderer = pickSegmentRenderer(seg, facts);
        if (!renderer) {
          return (
            <p key={i} className="message-text">
              {seg.content}
            </p>
          );
        }
        return <Fragment key={i}>{renderer.render(seg, facts)}</Fragment>;
      } catch {
        return (
          <p key={i} className="message-text">
            {seg.content}
          </p>
        );
      }
    });
  } catch {
    nodes = <p className="message-text">{content}</p>;
  }

  return <>{nodes}</>;
}
