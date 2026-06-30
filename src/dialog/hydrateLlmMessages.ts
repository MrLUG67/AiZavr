// src/dialog/hydrateLlmMessages.ts
// Гидрация ветки перед запросом к LLM: читает байты приложенных пользователем
// файлов (по storage_path через ядро) и превращает LlmMessage[] в ChatMessage[].
//
// Правило типов (решение по продукту):
//   - картинки / аудио / видео / бинарные документы (PDF, docx, …) → бинарная
//     media-часть (провайдер сам решит, поддерживает ли её модель);
//   - текстовые файлы (txt/md/csv/json/xml/html/log) → их СОДЕРЖИМОЕ инлайнится
//     прямо в текст сообщения (универсально принимается любой моделью).

import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage, ChatMediaPart } from "../widgets/host/types";
import type { LlmMessage, LlmAttachmentRef, MediaKind } from "./types";

interface AttachmentBytes {
  mime: string;
  extension: string;
  base64: string;
}

// Расширения, чьё содержимое осмысленно вставить как текст.
const INLINE_TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm",
  "log", "yml", "yaml", "ini", "toml", "rs", "ts", "tsx", "js", "jsx",
  "py", "java", "c", "cpp", "h", "css", "sql", "sh",
]);

// Сколько символов текстового файла максимум вставляем (защита от гигантских
// логов, которые выжрут окно контекста).
const MAX_INLINE_TEXT_CHARS = 200_000;

function isInlineText(ext: string): boolean {
  return INLINE_TEXT_EXT.has(ext.replace(/^\./, "").toLowerCase());
}

function mediaPartKind(kind: MediaKind): ChatMediaPart["kind"] {
  switch (kind) {
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "document":
      return "document";
    default:
      return "other";
  }
}

// base64 → строка UTF-8 (для инлайна текстовых файлов).
function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function readBytes(ref: LlmAttachmentRef): Promise<AttachmentBytes> {
  return invoke<AttachmentBytes>("cmd_read_attachment_base64", {
    storagePath: ref.storagePath,
    mime: ref.mime,
  });
}

async function hydrateOne(msg: LlmMessage): Promise<ChatMessage> {
  if (!msg.attachments?.length) {
    return { role: msg.role, content: msg.content };
  }

  let content = msg.content;
  const media: ChatMediaPart[] = [];

  for (const ref of msg.attachments) {
    let bytes: AttachmentBytes;
    try {
      bytes = await readBytes(ref);
    } catch (e) {
      // Файл пропал/не прочитался — не валим весь запрос: помечаем в тексте.
      console.error("read attachment failed:", ref.storagePath, e);
      content += `\n\n[Вложение «${ref.filename}» не удалось прочитать]`;
      continue;
    }

    if (isInlineText(ref.extension)) {
      let text = base64ToUtf8(bytes.base64);
      if (text.length > MAX_INLINE_TEXT_CHARS) {
        text = text.slice(0, MAX_INLINE_TEXT_CHARS) + "\n…[обрезано]";
      }
      content += `\n\n[Файл: ${ref.filename}]\n${text}`;
      continue;
    }

    media.push({
      kind: mediaPartKind(ref.mediaKind),
      mime: bytes.mime,
      base64: bytes.base64,
      filename: ref.filename,
      extension: bytes.extension || ref.extension,
    });
  }

  return {
    role: msg.role,
    content,
    ...(media.length > 0 ? { media } : {}),
  };
}

/** Прочитать все вложения ветки и собрать сообщения для провайдера. */
export async function hydrateLlmMessages(
  messages: LlmMessage[],
): Promise<ChatMessage[]> {
  return Promise.all(messages.map(hydrateOne));
}
