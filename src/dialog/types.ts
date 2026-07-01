// src/dialog/types.ts
// Типы данных основного диалога. Вынесены из App.tsx (шаг 1 расщепления
// контроллер<->презентация): и контроллер (useDialogController), и будущий
// презентационный слой (DialogView) импортируют формы отсюда, а не из App.

import type { ArtifactData } from "./artifactMedia";

// Ссылка на хранящийся файл вложения для отправки в LLM. Байты НЕ держим в
// памяти ветки — читаем по storage_path на шаге гидрации перед запросом.
export interface LlmAttachmentRef {
  storagePath: string;
  mime: string | null;
  extension: string;
  mediaKind: import("./artifactMedia").MediaKind;
  filename: string;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
  /** Вложения пользователя к этому сообщению (только у role: 'user'). */
  attachments?: LlmAttachmentRef[];
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  nodeId: string;
  nodeType: string;
  childrenCount: number;
  deletedChildrenCount: number;
  markers: MarkerData[];
  artifact: ArtifactData | null;
  /** Картинки/файлы внутри ответа ассистента (extra.attachments). */
  attachments: ArtifactData[];
  /** Модель, сгенерировавшая узел (для метрики запросов). null у Q/заглушек. */
  modelId: string | null;
  /** LLM-плагин, сгенерировавший узел. null у старых узлов/Q/заглушек. */
  pluginId: string | null;
}

export type { ArtifactData } from "./artifactMedia";
export type { MediaKind } from "./artifactMedia";

// Источник исходящего вложения — соответствует Rust-перечислению
// artifacts::AttachmentSource (serde tag = "origin"). Поля вложенных объектов
// идут в snake_case, как ждёт serde на бэкенде.
export type AttachmentSource =
  | { origin: "disk"; path: string }
  | {
      origin: "stored";
      storage_path: string;
      filename: string;
      extension: string;
      mime: string | null;
    };

// Черновик вложения в композере (чип над полем ввода до отправки).
export interface PendingAttachment {
  /** Локальный ключ для React/удаления. */
  id: string;
  source: AttachmentSource;
  filename: string;
  extension: string;
  mediaKind: import("./artifactMedia").MediaKind;
  /** Размер в байтах; 0 — неизвестен (свежий файл с диска). */
  sizeBytes: number;
}

export interface MarkerData {
  id: string;
  nodeId: string;
  label: string;
  comment: string | null;
}

// Данные A0-анкора корня (D-090) для хедера действий над лентой: корневой
// маркер #0, счётчики веток/удалённых. Сам A0 в ленту не идёт (скрыт по
// node_type), но его действия (⚑#0 / + / ⑂) живут в шапке беседы.
export interface RootActions {
  nodeId: string;
  childrenCount: number;
  deletedChildrenCount: number;
  markers: MarkerData[];
}

export interface DbDialog {
  id: string;
  title: string;
  notebook_id: string | null;
  root_node_id: string | null;
  active_leaf_id: string | null;
}

// Тег из справочника (миграция 009). name — нормализованный ключ, display_name —
// исходный регистр для показа.
export interface Tag {
  id: string;
  name: string;
  display_name: string;
  source: string;
  created_at: string;
}

// Тег + число помеченных им бесед (выдача поиска по тегам).
export interface TagHit extends Tag {
  dialog_count: number;
}

export interface DbNode {
  id: string;
  parent_id: string | null;
  dialog_id: string;
  node_type: string;
  content: string;
  active_child_id: string | null;
  model_id: string | null;
  plugin_id: string | null;
  children_count: number;
  branch_name: string | null;
  last_visited_leaf_id: string | null;
  is_deleted: boolean;
  extra: string | null;
  // Заготовка «на будущее» (облачная синхронизация аккаунтов); локально null.
  user_id: string | null;
}

export interface Notebook {
  id: string;
  parent_notebook_id: string | null;
  name: string;
  kind: string;
}

export interface SendResult {
  query_id: string;
  placeholder_id: string;
}

export interface BranchCard {
  nodeId: string;
  branchName: string;
  isActive: boolean;
}
