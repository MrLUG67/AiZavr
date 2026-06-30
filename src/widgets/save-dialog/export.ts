// Сборка документа из «богатого» диапазона диалога. Единый источник — список
// записей (Entry); из него строятся и HTML/DOC, и TXT. Картинки встраиваются
// data-URL'ами (resolved заранее в imageDataUrls по storagePath).

import type { ExportNode } from '../host/types';

export type SaveFormat = 'txt' | 'doc' | 'html' | 'pdf';

export interface ExportLabels {
  documentTitle: string;
  imagePlaceholder(filename: string): string;
  filePlaceholder(filename: string): string;
}

export interface ExportOptions {
  embedImages: boolean;
  embedModel: boolean;
  aliasQuestion: string;
  aliasAnswer: string;
  aliasSummary: string;
  /** storagePath -> data-URL; заполняется до сборки, если embedImages. */
  imageDataUrls: Map<string, string>;
  labels: ExportLabels;
  /** Подпись модели для ответа (plugin · model) или null. */
  modelSuffix(node: ExportNode): string | null;
}

export interface MediaRef {
  filename: string;
  /** data-URL, если картинка встроена; иначе null (плейсхолдер). */
  dataUrl: string | null;
}

export interface Entry {
  role: 'question' | 'answer' | 'summary' | 'artifact';
  alias: string;
  text: string;
  images: MediaRef[];
  files: string[];
  suffix: string | null;
}

/** Ссылки на картинки в диапазоне — для предзагрузки base64 (storagePath + mime). */
export function collectImageRefs(
  nodes: ExportNode[],
): { storagePath: string; mime: string | null }[] {
  const out: { storagePath: string; mime: string | null }[] = [];
  const seen = new Set<string>();
  const add = (a: { mediaKind: string; storagePath: string; mime: string | null }) => {
    if (a.mediaKind !== 'image' || !a.storagePath || seen.has(a.storagePath)) return;
    seen.add(a.storagePath);
    out.push({ storagePath: a.storagePath, mime: a.mime });
  };
  for (const n of nodes.slice(1)) {
    n.attachments.forEach(add);
    if (n.artifact) add(n.artifact);
  }
  return out;
}

// range[0] — граничный верхний A (D-063), в документ не входит — как в
// транскрипте компрессора/тегизатора.
export function buildEntries(nodes: ExportNode[], opts: ExportOptions): Entry[] {
  const out: Entry[] = [];
  const toMedia = (a: { filename: string; storagePath: string }): MediaRef => ({
    filename: a.filename,
    dataUrl: opts.embedImages ? opts.imageDataUrls.get(a.storagePath) ?? null : null,
  });

  for (const n of nodes.slice(1)) {
    if (n.nodeType === 'user_message' || n.nodeType === 'assistant_message') {
      const isAnswer = n.nodeType === 'assistant_message';
      const images: MediaRef[] = [];
      const files: string[] = [];
      for (const att of n.attachments) {
        if (att.mediaKind === 'image') images.push(toMedia(att));
        else files.push(att.filename);
      }
      out.push({
        role: isAnswer ? 'answer' : 'question',
        alias: isAnswer ? opts.aliasAnswer : opts.aliasQuestion,
        text: n.content,
        images,
        files,
        suffix: isAnswer && opts.embedModel ? opts.modelSuffix(n) : null,
      });
    } else if (n.nodeType === 'compressed_summary') {
      out.push({
        role: 'summary',
        alias: opts.aliasSummary,
        text: n.content,
        images: [],
        files: [],
        suffix: null,
      });
    } else if (n.nodeType === 'artifact' && n.artifact) {
      const att = n.artifact;
      const isImage = att.mediaKind === 'image';
      out.push({
        role: 'artifact',
        alias: '',
        text: '',
        images: isImage ? [toMedia(att)] : [],
        files: isImage ? [] : [att.filename],
        suffix: null,
      });
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Инлайновая разметка поверх уже экранированного текста (escapeHtml не трогает
// '*' и '`'). Инлайн-код `…` имеет приоритет: его содержимое НЕ обрабатывается на
// выделение — поэтому сначала вырезаем код-спаны, эмфазу применяем только вне их.
// Порядок эмфазы: тройные раньше двойных и одиночных.
function inlineMd(s: string): string {
  return s
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${part.slice(1, -1)}</code>`;
      }
      return part
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');
    })
    .join('');
}

// Markdown-подмножество для HTML/DOC: ATX-заголовки (#..######), списки (- и 1.),
// инлайн-выделение (*/**/***) и инлайн-код (`…`). Прочее — абзацы со <br>; пустая
// строка завершает абзац/список. Строки группируются в блоки.
function mdToHtml(text: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let items: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(para.join('<br>'));
      para = [];
    }
  };
  const flushList = () => {
    if (listType) {
      const lis = items.map((li) => `<li>${li}</li>`).join('');
      out.push(`<${listType}>${lis}</${listType}>`);
      listType = null;
      items = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
  };

  for (const raw of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    const ul = /^\s*-\s+(.*)$/.exec(raw);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(raw);

    if (raw.trim() === '') {
      flushAll();
    } else if (heading) {
      flushAll();
      const level = Math.min(heading[1].length, 6);
      out.push(`<h${level}>${inlineMd(escapeHtml(heading[2]))}</h${level}>`);
    } else if (ul) {
      flushPara();
      if (listType !== 'ul') flushList();
      listType = 'ul';
      items.push(inlineMd(escapeHtml(ul[1])));
    } else if (ol) {
      flushPara();
      if (listType !== 'ol') flushList();
      listType = 'ol';
      items.push(inlineMd(escapeHtml(ol[1])));
    } else {
      flushList();
      para.push(inlineMd(escapeHtml(raw)));
    }
  }
  flushAll();
  return out.join('\n');
}

// Для TXT: убираем сами знаки разметки (### , */**/***, обратные кавычки кода),
// оставляя текст. Маркеры списков (- / 1.) сохраняем — в тексте они читаемы.
function mdStrip(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      const body = m ? m[2] : line;
      return body
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1');
    })
    .join('\n');
}

const STYLE = `
  body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.5; color: #1a1a1a; max-width: 820px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 1.4em; border-bottom: 1px solid #ddd; padding-bottom: 8px; }
  .msg { margin: 0 0 18px; }
  .msg .alias { font-weight: 700; }
  .msg-question .alias { color: #1d4ed8; }
  .msg-answer .alias { color: #047857; }
  .msg-summary .alias { color: #b45309; }
  .msg .body { white-space: normal; margin-top: 2px; }
  .msg .model { font-size: 0.8em; color: #777; margin-top: 4px; }
  .msg img { max-width: 100%; height: auto; display: block; margin: 8px 0; border: 1px solid #eee; }
  .placeholder { font-style: italic; color: #888; }
  .msg .body h2 { font-size: 1.2em; margin: 10px 0 4px; }
  .msg .body h3 { font-size: 1.05em; margin: 8px 0 4px; }
  .msg .body h4, .msg .body h5, .msg .body h6 { font-size: 1em; margin: 6px 0 4px; }
  .msg .body ul, .msg .body ol { margin: 6px 0; padding-left: 24px; }
  .msg .body li { margin: 2px 0; }
  code { font-family: 'Consolas', 'Courier New', monospace; background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
`;

function renderEntryHtml(e: Entry, labels: ExportLabels): string {
  const parts: string[] = [`<div class="msg msg-${e.role}">`];
  if (e.alias) parts.push(`<span class="alias">${escapeHtml(e.alias)}</span>`);
  if (e.text) parts.push(`<div class="body">${mdToHtml(e.text)}</div>`);
  if (e.suffix) parts.push(`<div class="model">${escapeHtml(e.suffix)}</div>`);
  for (const img of e.images) {
    parts.push(
      img.dataUrl
        ? `<img src="${img.dataUrl}" alt="${escapeHtml(img.filename)}">`
        : `<div class="placeholder">${escapeHtml(labels.imagePlaceholder(img.filename))}</div>`,
    );
  }
  for (const f of e.files) {
    parts.push(`<div class="placeholder">${escapeHtml(labels.filePlaceholder(f))}</div>`);
  }
  parts.push(`</div>`);
  return parts.join('\n');
}

export function buildHtmlDocument(nodes: ExportNode[], opts: ExportOptions): string {
  const entries = buildEntries(nodes, opts);
  const body = entries.map((e) => renderEntryHtml(e, opts.labels)).join('\n');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>${escapeHtml(opts.labels.documentTitle)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(opts.labels.documentTitle)}</h1>
${body}
</body>
</html>`;
}

export function buildPlainText(nodes: ExportNode[], opts: ExportOptions): string {
  const entries = buildEntries(nodes, opts);
  const blocks = entries.map((e) => {
    const lines: string[] = [];
    const plain = e.text ? mdStrip(e.text) : '';
    const head = e.alias ? (plain ? `${e.alias} ${plain}` : e.alias) : plain;
    if (head) lines.push(head);
    if (e.suffix) lines.push(e.suffix);
    for (const img of e.images) lines.push(opts.labels.imagePlaceholder(img.filename));
    for (const f of e.files) lines.push(opts.labels.filePlaceholder(f));
    return lines.join('\n');
  });
  return `${opts.labels.documentTitle}\n\n${blocks.filter(Boolean).join('\n\n')}\n`;
}

/** Документ нужного формата (HTML и DOC используют один HTML; различие — в файле). */
export function buildDocument(
  format: SaveFormat,
  nodes: ExportNode[],
  opts: ExportOptions,
): string {
  if (format === 'txt') return buildPlainText(nodes, opts);
  return buildHtmlDocument(nodes, opts);
}
