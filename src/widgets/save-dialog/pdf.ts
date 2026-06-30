// PDF-рендерер на pdfmake из нашей Entry[]-модели (а не из HTML): векторный текст
// (выделяемый/ищется), кириллица (Roboto), заголовки/списки/эмфаза/инлайн-код и
// встроенные картинки. Модуль грузится лениво (dynamic import из index.ts), чтобы
// тяжёлый бандл pdfmake не попадал в основной чанк виджета.

import pdfMake from 'pdfmake/build/pdfmake';
import vfs from 'pdfmake/build/vfs_fonts';
import type { ExportNode } from '../host/types';
import {
  buildEntries,
  type Entry,
  type ExportOptions,
} from './export';

// Сегмент инлайн-текста pdfmake: строка или объект со стилями.
type Seg = string | { text: string; bold?: boolean; italics?: boolean; color?: string };
// Блоки контента pdfmake разнородны (text/ul/ol/image/style) — держим как any[],
// строгая типизация docDefinition тут пользы не даёт.
type Block = Record<string, unknown>;

const CODE_COLOR = '#9333ea';

let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  const v = (vfs as unknown as { default?: unknown }).default ?? vfs;
  // pdfmake 0.3.x: vfs регистрируется явно, как и словарь шрифтов.
  pdfMake.addVirtualFileSystem(v as never);
  pdfMake.setFonts({
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
  });
  fontsReady = true;
}

// Инлайн-код (`…`) имеет приоритет: его содержимое не обрабатывается на эмфазу.
function parseInline(s: string): Seg[] {
  const out: Seg[] = [];
  for (const part of s.split(/(`[^`]+`)/g)) {
    if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
      out.push({ text: part.slice(1, -1), color: CODE_COLOR });
    } else {
      parseEmphasis(part, out);
    }
  }
  return out.length ? out : [''];
}

// ***жирный курсив***, **жирный**, *курсив*. Содержимое выделения без '*' внутри.
function parseEmphasis(text: string, out: Seg[]): void {
  if (!text) return;
  const re = /\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push({ text: m[1], bold: true, italics: true });
    else if (m[2] !== undefined) out.push({ text: m[2], bold: true });
    else if (m[3] !== undefined) out.push({ text: m[3], italics: true });
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
}

// Markdown-подмножество -> блоки pdfmake: заголовки (#..######), списки (- / 1.),
// абзацы со переносами; инлайн — через parseInline.
function mdToPdf(text: string): Block[] {
  const blocks: Block[] = [];
  let para: Seg[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let items: Block[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ text: para, margin: [0, 0, 0, 4] });
      para = [];
    }
  };
  const flushList = () => {
    if (listType) {
      blocks.push({ [listType]: items, margin: [0, 0, 0, 4] });
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
      blocks.push({ text: parseInline(heading[2]), style: `h${level}` });
    } else if (ul) {
      flushPara();
      if (listType !== 'ul') flushList();
      listType = 'ul';
      items.push({ text: parseInline(ul[1]) });
    } else if (ol) {
      flushPara();
      if (listType !== 'ol') flushList();
      listType = 'ol';
      items.push({ text: parseInline(ol[1]) });
    } else {
      flushList();
      if (para.length) para.push('\n');
      para.push(...parseInline(raw));
    }
  }
  flushAll();
  return blocks;
}

function aliasColor(role: Entry['role']): string {
  switch (role) {
    case 'question':
      return '#1d4ed8';
    case 'answer':
      return '#047857';
    case 'summary':
      return '#b45309';
    default:
      return '#444444';
  }
}

export async function buildPdfBase64(
  nodes: ExportNode[],
  opts: ExportOptions,
): Promise<string> {
  ensureFonts();
  const entries = buildEntries(nodes, opts);

  const content: Block[] = [{ text: opts.labels.documentTitle, style: 'title' }];
  for (const e of entries) {
    if (e.alias) {
      content.push({
        text: e.alias,
        bold: true,
        color: aliasColor(e.role),
        margin: [0, 6, 0, 1],
      });
    }
    if (e.text) content.push(...mdToPdf(e.text));
    if (e.suffix) {
      content.push({ text: e.suffix, fontSize: 8, color: '#777777', margin: [0, 1, 0, 2] });
    }
    for (const img of e.images) {
      content.push(
        img.dataUrl
          ? { image: img.dataUrl, fit: [480, 480], margin: [0, 4, 0, 4] }
          : { text: opts.labels.imagePlaceholder(img.filename), italics: true, color: '#888888' },
      );
    }
    for (const f of e.files) {
      content.push({ text: opts.labels.filePlaceholder(f), italics: true, color: '#888888' });
    }
  }

  const docDefinition: Record<string, unknown> = {
    info: { title: opts.labels.documentTitle },
    content,
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.3 },
    styles: {
      title: { fontSize: 18, bold: true, margin: [0, 0, 0, 10] },
      h1: { fontSize: 16, bold: true, margin: [0, 6, 0, 3] },
      h2: { fontSize: 14, bold: true, margin: [0, 6, 0, 3] },
      h3: { fontSize: 12.5, bold: true, margin: [0, 5, 0, 3] },
      h4: { fontSize: 11.5, bold: true, margin: [0, 4, 0, 2] },
      h5: { fontSize: 11, bold: true, margin: [0, 4, 0, 2] },
      h6: { fontSize: 11, bold: true, italics: true, margin: [0, 4, 0, 2] },
    },
    pageMargins: [40, 40, 40, 50],
    footer: (currentPage: number, pageCount: number) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      color: '#999999',
      margin: [0, 10, 0, 0],
    }),
  };

  const pdf = pdfMake.createPdf(docDefinition as never);
  return pdf.getBase64();
}
