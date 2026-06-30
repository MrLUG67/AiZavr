// src/widgets/host/capabilities.ts
// ЕДИНСТВЕННАЯ точка, где invoke существует на стороне виджетов (D-072).
// Плагин этот файл НЕ импортирует — получает готовый WidgetCapabilities.
// Whitelist cmd_* здесь = полный список разрешений плагина.
// Адаптер формы: Rust snake_case <-> контракт camelCase (types.ts).
//
// Имена аргументов: Tauri v2 конвертирует JS camelCase -> Rust snake_case
// автоматически (команды объявлены без rename_all). Сверено с lib.rs (сессия 7).
// Структуры Marker / ReachableEnd / DbNode сверены с db/mod.rs и markers/mod.rs.

import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type {
  WidgetCapabilities,
  Marker,
  ReachableEnd,
  NodeView,
  ChatMessage,
  CompressionProvenance,
  HelpDoc,
  PreviewDoc,
  PreviewHandlers,
  FormDoc,
  ExportNode,
  ExportAttachment,
  ExportImage,
  SaveFileArgs,
  SaveBinaryFileArgs,
} from './types';
import { callCompression } from '../llm/compressionRegistry';
import { callTagging } from '../llm/taggingRegistry';
import { parseMessageAttachments, parseArtifactExtra } from '../../dialog/artifactMedia';

// ---------------------------------------------------------------------------
// Сырые формы из Rust (snake_case)
// ---------------------------------------------------------------------------

// markers::Marker — сверено (markers/mod.rs). created_at есть в Rust, не маплю.
interface RawMarker {
  id: string;
  node_id: string;
  label: string;
  comment: string | null;
}

// markers::ReachableEnd — сверено (markers/mod.rs).
// Узел может быть И маркером, И листом (marker_id + is_leaf одновременно).
interface RawReachableEnd {
  node_id: string;
  marker_id: string | null;
  label: string | null;
  is_leaf: boolean;
}

// DbNode — то, что РЕАЛЬНО возвращает cmd_resolve_linear_range (Vec<DbNode>).
// Берём только поля для проекции в NodeView; остальные игнорируем.
interface RawDbNode {
  id: string;
  parent_id: string | null;
  node_type: NodeView['nodeType'];
  content: string;
  // tokens_count, model_id, extra, is_deleted, ... — не нужны для NodeView
}

// ---- адаптеры формы snake_case -> контракт camelCase ----

function toMarker(r: RawMarker): Marker {
  return { id: r.id, nodeId: r.node_id, label: r.label, comment: r.comment };
}

// Rust-форма {node_id, marker_id?, label?, is_leaf} -> контракт {nodeId, kind, label}.
// kind: размечен маркером -> 'marker' (даже если узел заодно лист — маркер
// приоритетнее для подписи); иначе 'leaf'. label: имя маркера, иначе запасная
// подпись листа (у листа без маркера имени нет — D-059). types.ts требует
// label: string (non-null), поэтому null здесь не пропускаем.
function toReachableEnd(r: RawReachableEnd): ReachableEnd {
  const kind: ReachableEnd['kind'] = r.marker_id ? 'marker' : 'leaf';
  const label = r.label ?? 'лист';
  return { nodeId: r.node_id, kind, label };
}

// DbNode -> NodeView: курированная проекция (пока в адаптере, потом в ядре).
// content -> text; метки DbNode не несёт -> пустой markers.
// TODO(core projection): при D-078 приватные диапазоны ДОЛЖНЫ вырезаться в ЯДРЕ
// (отдельной командой/флагом), не в этом адаптере — иначе приватный контент
// долетает до фронта плагина до вырезания.
function dbNodeToView(r: RawDbNode): NodeView {
  return {
    id: r.id,
    parentId: r.parent_id,
    nodeType: r.node_type,
    text: r.content,
    markers: [], // resolveLinearRange отдаёт текст диапазона; метки тут не нужны
  };
}

// Полная форма DbNode для экспорта (в отличие от обеднённого NodeView): нужны
// происхождение (model/plugin) и extra с вложениями. Поля сверены с db/mod.rs.
interface RawExportNode {
  id: string;
  parent_id: string | null;
  node_type: NodeView['nodeType'];
  content: string;
  model_id: string | null;
  plugin_id: string | null;
  extra: string | null;
}

// AttachmentData (dialog/artifactMedia) -> ExportAttachment (контракт плагина).
// Формы совпадают по смыслу; перекладываем явно, чтобы плагин не зависел от
// app-типа ArtifactData.
function toExportAttachment(a: {
  mediaKind: ExportAttachment['mediaKind'];
  filename: string;
  extension: string;
  mime: string | null;
  storagePath: string;
}): ExportAttachment {
  return {
    mediaKind: a.mediaKind,
    filename: a.filename,
    extension: a.extension,
    mime: a.mime,
    storagePath: a.storagePath,
  };
}

function dbNodeToExport(r: RawExportNode): ExportNode {
  const isMessage =
    r.node_type === 'assistant_message' || r.node_type === 'user_message';
  return {
    id: r.id,
    nodeType: r.node_type,
    content: r.content,
    modelId: r.model_id,
    pluginId: r.plugin_id,
    attachments: isMessage
      ? parseMessageAttachments(r.extra).map(toExportAttachment)
      : [],
    artifact:
      r.node_type === 'artifact'
        ? (() => {
            const a = parseArtifactExtra(r.extra);
            return a ? toExportAttachment(a) : null;
          })()
        : null,
  };
}

// AttachmentBytes из Rust (cmd_read_attachment_base64).
interface RawAttachmentBytes {
  mime: string;
  extension: string;
  base64: string;
}

// ---------------------------------------------------------------------------
// Зависимости от App (не invoke)
// ---------------------------------------------------------------------------

export interface CapabilityDeps {
  onFocus: (nodeId: string) => void;       // намерение в центр (D-072), исполняет App
  getActiveDialogId: () => string | null;  // лениво: активный диалог в момент вызова
  // дерево изменилось ядровой операцией плагина (напр. attach сжатия сдвинул
  // курсор на заглушку под S) — App перечитывает активную ветку. Координация
  // панель<->центр, как onFocus; плагин про это не знает.
  onTreeChanged: () => void;
  // теги активного диалога изменены плагином — App перечитывает чипы в шапке
  // беседы (отдельно от onTreeChanged: ветка не менялась, только теги).
  onDialogTagsChanged: () => void;
  // плагин просит показать свою справку в центре (вместо диалога). Исполняет App.
  onOpenHelp: (doc: HelpDoc) => void;
  onOpenPreview: (doc: PreviewDoc, handlers: PreviewHandlers) => void;
  onClosePreview: () => void;
  onOpenForm: (doc: FormDoc) => void;
  onRefreshForm: (doc: FormDoc) => void;
  onCloseForm: () => void;
}

function notWired(what: string, when: string): never {
  throw new Error(`Capability "${what}" недоступна: ${when}`);
}

// ---------------------------------------------------------------------------
// Фабрика. Каждый метод привязан к ОДНОЙ cmd_* (или к onFocus).
// Нет: generic invoke, fetch, ключей, хэндла к БД.
// ---------------------------------------------------------------------------

export function makeCapabilities(
  deps: CapabilityDeps,
  pluginId: string,
): WidgetCapabilities {
  return {
    // -- markers.read: реально (сессия 7) -----------------------------------
    markers: {
      async listStartable(): Promise<Marker[]> {
        const dialogId = deps.getActiveDialogId();
        if (!dialogId) return [];
        // lib.rs: cmd_list_startable_markers(dialog_id) -> JS ключ dialogId
        const raw = await invoke<RawMarker[]>('cmd_list_startable_markers', {
          dialogId,
        });
        return raw.map(toMarker);
      },

      async listReachableEnds(startNodeId: string): Promise<ReachableEnd[]> {
        // lib.rs: cmd_list_reachable_ends(from_node_id) -> JS ключ fromNodeId
        const raw = await invoke<RawReachableEnd[]>('cmd_list_reachable_ends', {
          fromNodeId: startNodeId,
        });
        return raw.map(toReachableEnd);
      },

      async resolveLinearRange(
        start: string,
        end: string,
      ): Promise<NodeView[]> {
        // lib.rs: cmd_resolve_linear_range(start_node_id, end_node_id) -> Vec<DbNode>
        const raw = await invoke<RawDbNode[]>('cmd_resolve_linear_range', {
          startNodeId: start,
          endNodeId: end,
        });
        return raw.map(dbNodeToView);
      },
    },

    // -- compression.attach: ждёт cmd_attach_compressed (НЕТ в lib.rs, TODO) --
    compression: {
      async attach(args: {
        startNodeId: string;
        endNodeId: string;
        summaryText: string;
        placeholderText: string | null;
        modelId: string | null;
        provenance: CompressionProvenance;
      }): Promise<void> {
        // cmd_attach_compressed (compression/mod.rs): создаёт S + заглушку +
        // extra.compression (D-060/061/065) + провенанс модели на S (D-088).
        await invoke<void>('cmd_attach_compressed', {
          startNodeId: args.startNodeId,
          endNodeId: args.endNodeId,
          summaryText: args.summaryText,
          placeholderText: args.placeholderText,
          modelId: args.modelId, // D-088: модель-уплотнитель (null у заглушки)
          provenance: args.provenance, // непрозрачно в extra.compression (D-065)
        });
        // Курсор уехал на заглушку под S — просим App перечитать ветку.
        deps.onTreeChanged();
      },
    },

    // -- model.call: опосредованный вызов, КЛЮЧ В ЯДРЕ (D-073) ---------------
    //    Маршрутизация по роли — слой ролей v0.2. В MVP не заведено.
    model: {
      async call(role: string, messages: ChatMessage[]): Promise<string> {
        if (role === 'compression' || role.startsWith('compression_')) {
          const resp = await callCompression(messages);
          return resp.content;
        }
        if (role === 'tagging' || role.startsWith('tagging_')) {
          const resp = await callTagging(messages);
          return resp.content;
        }
        return notWired(
          `model.call(role="${role}")`,
          'роль не поддерживается; для диалога используется активный LLM-плагин',
        );
      },
    },

    // -- secrets: API-ключи плагинов в системном keychain ядра ---------------
    secrets: {
      async set(providerId: string, apiKey: string): Promise<void> {
        await invoke<void>('cmd_set_api_key', { providerId, apiKey });
      },
      async get(providerId: string): Promise<string | null> {
        return invoke<string | null>('cmd_get_api_key', { providerId });
      },
      async delete(providerId: string): Promise<void> {
        await invoke<void>('cmd_delete_api_key', { providerId });
      },
    },

    // -- config: конфиг плагина в файле ядра (D-095) -------------------------
    //    pluginId привязан к ЭТОМУ cap (per-widget, WidgetHost) — плагин его не
    //    передаёт, чужой конфиг недоступен by construction.
    config: {
      async load(): Promise<string | null> {
        return invoke<string | null>('cmd_load_plugin_config', { pluginId });
      },
      async save(json: string): Promise<void> {
        await invoke<void>('cmd_save_plugin_config', { pluginId, contents: json });
      },
    },

    // -- ui.focus / ui.openHelp: намерения в центр, исполняет App -----------
    ui: {
      focus(nodeId: string): void {
        deps.onFocus(nodeId);
      },
      openHelp(doc): void {
        deps.onOpenHelp(doc);
      },
      openPreview(doc, handlers): void {
        deps.onOpenPreview(doc, handlers);
      },
      closePreview(): void {
        deps.onClosePreview();
      },
      openForm(doc): void {
        deps.onOpenForm(doc);
      },
      refreshForm(doc): void {
        deps.onRefreshForm(doc);
      },
      closeForm(): void {
        deps.onCloseForm();
      },
    },
    // -- export: «богатый» диапазон + чтение картинок + запись файла ---------
    export: {
      async resolveRichRange(start: string, end: string): Promise<ExportNode[]> {
        const raw = await invoke<RawExportNode[]>('cmd_resolve_linear_range', {
          startNodeId: start,
          endNodeId: end,
        });
        return raw.map(dbNodeToExport);
      },

      async loadImageBase64(
        storagePath: string,
        mime: string | null,
      ): Promise<ExportImage> {
        const bytes = await invoke<RawAttachmentBytes>('cmd_read_attachment_base64', {
          storagePath,
          mime,
        });
        return { mime: bytes.mime, base64: bytes.base64 };
      },

      async saveFile(args: SaveFileArgs): Promise<boolean> {
        // Системный диалог сохранения (plugin-dialog). Запись делает ядро
        // (cmd_write_export_file) — у плагина нет прямого доступа к ФС.
        const path = await save({
          defaultPath: args.defaultName,
          filters: [
            { name: args.extension.toUpperCase(), extensions: [args.extension] },
          ],
        });
        if (!path) return false;
        await invoke<void>('cmd_write_export_file', {
          path,
          contents: args.contents,
        });
        return true;
      },

      async saveBinaryFile(args: SaveBinaryFileArgs): Promise<boolean> {
        const path = await save({
          defaultPath: args.defaultName,
          filters: [
            { name: args.extension.toUpperCase(), extensions: [args.extension] },
          ],
        });
        if (!path) return false;
        await invoke<void>('cmd_write_export_file_base64', {
          path,
          base64Data: args.base64,
        });
        return true;
      },
    },

    tags: {
      // Контракт плагинов остаётся строковым (display-имена тегов); под капотом —
      // справочник tags (миграция 009), маппим объекты к именам.
      async getForActiveDialog(): Promise<string[]> {
        const dialogId = deps.getActiveDialogId();
        if (!dialogId) return [];
        const tags = await invoke<{ display_name: string }[]>('cmd_get_dialog_tags', { dialogId });
        return tags.map((t) => t.display_name);
      },
      // Весь справочник тегов (display-имена) — для подсказки модели тегизатора.
      async listDictionary(): Promise<string[]> {
        const tags = await invoke<{ display_name: string }[]>('cmd_list_tags');
        return tags.map((t) => t.display_name);
      },
      async setForActiveDialog(tags: string[], source?: string): Promise<string[]> {
        const dialogId = deps.getActiveDialogId();
        if (!dialogId) {
          throw new Error('Нет активного диалога');
        }
        const updated = await invoke<{ display_name: string }[]>('cmd_set_dialog_tags', {
          dialogId,
          tags,
          source: source ?? 'manual',
        });
        deps.onDialogTagsChanged();
        return updated.map((t) => t.display_name);
      },
    },
  };
}