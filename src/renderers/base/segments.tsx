// src/renderers/base/segments.tsx
// Базовые рендереры сегментов (фолбэк-слой). Рисуют то, что вернул базовый парсер:
//   - text: блочный markdown (заголовки #/##/###…, маркированные и нумерованные
//           списки, абзацы) + инлайн (**жирный**, *курсив*, `код`). Абзацы
//           сохраняют переносы/отступы (pre-wrap) — прежнее поведение <p>;
//   - code: «фрейм» кода — ярлык языка ПЕРЕД блоком (если язык указан) и кнопка
//           «копировать» ПОСЛЕ блока (обязательно). Цвет рамки/фона — из палитры
//           диалога (акцент), оформление в App.css.
//
// Markdown разбираем САМИ, без зависимостей. Подсветки синтаксиса в коде НЕТ
// (оставлено на будущее за спец-плагинами). Внутри code-сегмента markdown НЕ
// трогаем — он уже отделён парсером (код печатается дословно).

import { useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { copyToClipboard } from '../../dialog/clipboard';
import type { Segment, SegmentRenderer } from '../host/types';

// --- Инлайн-разметка -------------------------------------------------------
// Однопроходный разбор: на каждом шаге пробуем «спец-токен» в начале остатка,
// иначе копим обычный текст. Порядок важен: код раньше эмфазы (внутри `…` ** не
// форматируем), жирный (**/__) раньше курсива (*/_), иначе ** съест одиночная *.
function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buf = '';
  let key = 0;
  let i = 0;

  const flush = () => {
    if (buf) {
      nodes.push(buf);
      buf = '';
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      flush();
      nodes.push(
        <code key={`i${key++}`} className="inline-code">
          {code[1]}
        </code>,
      );
      i += code[0].length;
      continue;
    }

    const bold = /^\*\*([^\n]+?)\*\*/.exec(rest) ?? /^__([^\n]+?)__/.exec(rest);
    if (bold) {
      flush();
      nodes.push(<strong key={`i${key++}`}>{parseInline(bold[1])}</strong>);
      i += bold[0].length;
      continue;
    }

    const italic =
      /^\*([^\s*][^\n]*?)\*/.exec(rest) ?? /^_([^\s_][^\n]*?)_/.exec(rest);
    if (italic) {
      flush();
      nodes.push(<em key={`i${key++}`}>{parseInline(italic[1])}</em>);
      i += italic[0].length;
      continue;
    }

    buf += text[i];
    i += 1;
  }

  flush();
  return nodes;
}

// --- Блочная разметка ------------------------------------------------------
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const UL_RE = /^\s*[-*+]\s+(.+)$/;
const OL_RE = /^\s*\d+[.)]\s+(.+)$/;

function renderBlocks(content: string): ReactNode[] {
  const lines = content.split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let key = 0;
  let i = 0;

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push(
        <p key={`b${key++}`} className="message-text">
          {parseInline(para.join('\n'))}
        </p>,
      );
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      const level = Math.min(heading[1].length, 6);
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      blocks.push(
        <Tag key={`b${key++}`} className={`md-h md-h${level}`}>
          {parseInline(heading[2])}
        </Tag>,
      );
      i += 1;
      continue;
    }

    if (UL_RE.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const m = UL_RE.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      blocks.push(
        <ul key={`b${key++}`} className="md-list">
          {items.map((it, idx) => (
            <li key={idx}>{parseInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (OL_RE.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const m = OL_RE.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      blocks.push(
        <ol key={`b${key++}`} className="md-list">
          {items.map((it, idx) => (
            <li key={idx}>{parseInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      i += 1;
      continue;
    }

    para.push(line);
    i += 1;
  }

  flushPara();
  return blocks;
}

function TextSegment({ content }: { content: string }): React.ReactElement {
  return <>{renderBlocks(content)}</>;
}

function CodeBlock({
  lang,
  content,
}: {
  lang: string | null;
  content: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyToClipboard(content);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="code-block">
      {lang && <div className="code-block__lang">{lang}</div>}
      <pre className="code-block__pre">
        <code>{content}</code>
      </pre>
      <div className="code-block__foot">
        <button
          type="button"
          className="code-copy-btn"
          title={t('app.copyCode')}
          aria-label={t('app.copyCode')}
          onClick={onCopy}
        >
          {copied ? t('app.copied') : `⧉ ${t('app.copyCode')}`}
        </button>
      </div>
    </div>
  );
}

export const baseSegmentRenderers: SegmentRenderer[] = [
  {
    manifest: {
      id: 'base.text',
      title: 'Базовый текст',
      supportedModels: '*',
      order: 1000,
    },
    matches: (seg: Segment) => seg.kind === 'text',
    render: (seg: Segment) =>
      seg.kind === 'text' ? <TextSegment content={seg.content} /> : null,
  },
  {
    manifest: {
      id: 'base.code',
      title: 'Базовый код',
      supportedModels: '*',
      order: 1000,
    },
    matches: (seg: Segment) => seg.kind === 'code',
    render: (seg: Segment) =>
      seg.kind === 'code' ? (
        <CodeBlock lang={seg.lang} content={seg.content} />
      ) : null,
  },
];
