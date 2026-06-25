// src/renderers/base/parser.ts
// Базовый парсер ответа в сегменты: выделяет fenced-блоки кода (``` или ~~~,
// с опциональным указанием языка) и оставляет всё прочее текстом. Это и есть
// «выделение участков кода по умолчанию». Подсветку синтаксиса НЕ делаем —
// разбор только структурный (где код, какой язык), оформление — за рендерером.
//
// Устойчивость: незакрытый блок (модель забыла закрывающий забор) трактуем как
// код до конца ответа — лучше показать как код, чем как сырой текст с ```.

import type { ContentParser, Segment } from '../host/types';

// Открывающий забор: возможны ведущие пробелы, 3+ символа (` или ~), затем
// опциональный язык (буквы/цифры/+ - . # _ — покрывает c++, c#, objective-c).
// Инфо-строку со словами после языка (редкость) не матчим — тогда строка уйдёт
// в текст, что безопасно.
const OPEN_RE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+\-.#]*)\s*$/;

export function parseSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  const lines = content.split('\n');
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length > 0) {
      segments.push({ kind: 'text', content: textBuf.join('\n') });
      textBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(OPEN_RE);
    if (open) {
      const fenceChar = open[1][0]; // '`' или '~'
      const fenceLen = open[1].length;
      const lang = open[2] ? open[2] : null;

      const codeLines: string[] = [];
      i++; // уходим со строки открывающего забора
      while (i < lines.length) {
        const close = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
          i++; // съедаем закрывающий забор
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }

      flushText();
      segments.push({ kind: 'code', lang, content: codeLines.join('\n') });
      continue;
    }

    textBuf.push(lines[i]);
    i++;
  }

  flushText();
  return segments;
}

// Базовый парсер-фолбэк: применим к любой модели, стоит последним в реестре.
export const baseParser: ContentParser = {
  manifest: {
    id: 'base.parser',
    title: 'Базовый разбор',
    supportedModels: '*',
    order: 1000,
  },
  parse: (content) => parseSegments(content),
};
