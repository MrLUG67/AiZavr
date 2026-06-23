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
import type {
  WidgetCapabilities,
  Marker,
  ReachableEnd,
  NodeView,
  ChatMessage,
  CompressionProvenance,
} from './types';

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
}

function notWired(what: string, when: string): never {
  throw new Error(`Capability "${what}" недоступна: ${when}`);
}

// ---------------------------------------------------------------------------
// Фабрика. Каждый метод привязан к ОДНОЙ cmd_* (или к onFocus).
// Нет: generic invoke, fetch, ключей, хэндла к БД.
// ---------------------------------------------------------------------------

export function makeCapabilities(deps: CapabilityDeps): WidgetCapabilities {
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
      async call(role: string, _messages: ChatMessage[]): Promise<string> {
        return notWired(
          `model.call(role="${role}")`,
          'опосредованный вызов модели по роли появится со слоем ролей (v0.2)',
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

    // -- ui.focus: намерение в центр, исполняет App -------------------------
    ui: {
      focus(nodeId: string): void {
        deps.onFocus(nodeId);
      },
    },
  };
}