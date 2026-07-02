// src/dialog/TreeCanvas.tsx
// Нативный визуализатор всего дерева беседы (плагин «Дерево»). Полностью
// замещает ленту диалога, пока открыт (treeDoc != null). Топологию читает сам
// (cmd_get_full_tree) — плагин присылает лишь опции показа (TreeDoc). Цвета
// узлов берутся из общих CSS-переменных (--bubble-*/--marker-*), поэтому дерево
// и лента всегда одного цвета.
//
// Иерархия сверху вниз, начало — от маркера #0 (A0-анкор). Q/A/S — маленькие
// прямоугольники без текста; текст несут только маркеры (комментарий или #N).
// Служебные узлы скрыты: Q0-анкор, заглушка сжатия (её дети подвешиваются к S),
// system/context_migration. Связи — тонкие ортогональные линии без стрелок.
//
// Мышь: зажатие+движение по полотну = панорамирование; колесо = вертикальный
// скролл (нативный overflow). Одиночный клик по Q/A/S = плавающая ZOOM-карточка
// (первые строки текста + прокрутка), по артефакту = открыть системным средством.
// Двойной клик по «живому» узлу = закрыть дерево и доскроллить к нему в ленте;
// по удалённому — подсказка «сначала восстановите ветку».

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { TreeDoc } from "../widgets/host/types";
import type { DialogController } from "./useDialogController";
import { parseArtifactExtra, parseMessageAttachments } from "./artifactMedia";
import { MediaKindIcon } from "./MediaKindIcon";
import { resolveModelName } from "../widgets/llm/registry";

// --- сырьё из Rust (snake_case) -------------------------------------------

interface RawTreeMarker {
  id: string;
  node_id: string;
  label: string;
  comment: string | null;
  created_at: string;
}

interface RawTreeNode {
  id: string;
  parent_id: string | null;
  node_type: string;
  content: string;
  active_child_id: string | null;
  is_deleted: boolean;
  model_id: string | null;
  plugin_id: string | null;
  extra: string | null;
  created_at: string;
  markers: RawTreeMarker[];
}

export interface TreeMarker {
  id: string;
  label: string;
  comment: string | null;
}

export interface TreeNodeData {
  id: string;
  parentId: string | null;
  nodeType: string;
  content: string;
  activeChildId: string | null;
  isDeleted: boolean;
  modelId: string | null;
  pluginId: string | null;
  extra: string | null;
  createdAt: string;
  markers: TreeMarker[];
}

function toTreeNode(r: RawTreeNode): TreeNodeData {
  return {
    id: r.id,
    parentId: r.parent_id,
    nodeType: r.node_type,
    content: r.content,
    activeChildId: r.active_child_id,
    isDeleted: r.is_deleted,
    modelId: r.model_id,
    pluginId: r.plugin_id,
    extra: r.extra,
    createdAt: r.created_at,
    markers: r.markers.map((m) => ({ id: m.id, label: m.label, comment: m.comment })),
  };
}

// --- геометрия раскладки ---------------------------------------------------

const H_GAP = 64; // шаг между колонками (центр-к-центру), px
const V_GAP = 78; // шаг между уровнями, px
const PAD = 44; // внешний отступ полотна, px
const NODE_W = 46; // ширина прямоугольника Q/A/S, px
const NODE_H = 26; // базовая высота прямоугольника, px

// Стопка иконок артефактов внутри пузыря (2+): столбиком справа. Высота пузыря
// растёт под их число (ширина неизменна). Размеры согласованы с CSS
// .tree-node-attachment (16px) и .tree-node-attachments (gap/padding).
const ATT_ROW = 16; // высота одной иконки-кнопки, px
const ATT_GAP = 2; // зазор между иконками, px
const ATT_PADV = 2; // вертикальный внутренний отступ контейнера, px

function iconCount(node: TreeNodeData, kind: CellKind): number {
  if (kind === "q" || kind === "a") return parseMessageAttachments(node.extra).length;
  if (kind === "artifact") return 1;
  return 0;
}

function cellHeight(count: number): number {
  if (count <= 1) return NODE_H;
  return Math.max(NODE_H, count * ATT_ROW + (count - 1) * ATT_GAP + ATT_PADV * 2);
}

type CellKind = "root" | "q" | "a" | "s" | "artifact" | "pending";

interface Cell {
  node: TreeNodeData;
  kind: CellKind;
  col: number; // дробная колонка (у внутренних — среднее детей)
  depth: number;
  cx: number; // пиксельный центр X
  cy: number; // пиксельный центр Y
  h: number; // высота пузыря, px (растёт под стопку иконок артефактов)
}

interface Edge {
  id: string;
  path: string;
  deleted: boolean;
}

interface Layout {
  cells: Cell[];
  edges: Edge[];
  width: number;
  height: number;
}

// Служебные узлы, которые сами не рисуются, а «прозрачны» — их дети
// поднимаются к родителю (заглушка сжатия под S, системные узлы).
function isPassThrough(nodeType: string): boolean {
  return (
    nodeType === "compression_placeholder" ||
    nodeType === "system" ||
    nodeType === "context_migration"
  );
}

function kindOf(node: TreeNodeData, isRoot: boolean): CellKind {
  if (isRoot || node.nodeType === "root_anchor") return "root";
  switch (node.nodeType) {
    case "assistant_message":
      return "a";
    case "user_message":
      return "q";
    case "compressed_summary":
      return "s";
    case "artifact":
      return "artifact";
    case "unanswered_placeholder":
      return "pending";
    default:
      return "a";
  }
}

function buildLayout(
  nodes: TreeNodeData[],
  showDeleted: boolean,
  showUnanswered: boolean,
): Layout {
  const byId = new Map<string, TreeNodeData>();
  const childrenByParent = new Map<string, TreeNodeData[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (n.parentId) {
      const arr = childrenByParent.get(n.parentId);
      if (arr) arr.push(n);
      else childrenByParent.set(n.parentId, [n]);
    }
  }

  // «Единица без ответа»: сама заглушка ответа (unanswered_placeholder) или Q,
  // чьим единственным ответом осталась такая заглушка (реального A под ним нет).
  // При showUnanswered=false такие узлы «прозрачны» — их реальное продолжение
  // (напр. Q→A после ретрая под заглушкой) поднимается к родителю.
  function isUnansweredUnit(node: TreeNodeData): boolean {
    if (node.nodeType === "unanswered_placeholder") return true;
    if (node.nodeType === "user_message") {
      const kids = childrenByParent.get(node.id) ?? [];
      return (
        kids.length > 0 &&
        kids.every((k) => k.nodeType === "unanswered_placeholder")
      );
    }
    return false;
  }

  // Корень визуализации — A0 (root_anchor c родителем Q0), несёт маркер #0.
  const q0 = nodes.find((n) => n.parentId === null && n.nodeType === "root_anchor");
  const displayRoot = q0 ? (childrenByParent.get(q0.id) ?? [])[0] : undefined;

  const cells: Cell[] = [];
  const edges: Edge[] = [];
  if (!displayRoot) {
    return { cells, edges, width: PAD * 2, height: PAD * 2 };
  }

  // Видимые (для дерева) дети узла: пропускаем удалённые (если не показываем),
  // «прозрачные» служебные заменяем их детьми.
  function visibleChildren(node: TreeNodeData): TreeNodeData[] {
    const raw = childrenByParent.get(node.id) ?? [];
    const out: TreeNodeData[] = [];
    for (const c of raw) {
      if (!showDeleted && c.isDeleted) continue;
      if (isPassThrough(c.nodeType)) {
        out.push(...visibleChildren(c));
        continue;
      }
      if (!showUnanswered && isUnansweredUnit(c)) {
        // Прячем запрос/заглушку без ответа, но поднимаем реальное продолжение.
        out.push(...visibleChildren(c));
        continue;
      }
      out.push(c);
    }
    return out;
  }

  let nextCol = 0;
  let maxDepth = 0;

  function assign(node: TreeNodeData, depth: number, isRoot: boolean): Cell {
    if (depth > maxDepth) maxDepth = depth;
    const kind = kindOf(node, isRoot);
    const cell: Cell = {
      node,
      kind,
      col: 0,
      depth,
      cx: 0,
      cy: 0,
      h: cellHeight(iconCount(node, kind)),
    };
    cells.push(cell);

    const kids = visibleChildren(node);
    if (kids.length === 0) {
      cell.col = nextCol;
      nextCol += 1;
    } else {
      const childCells = kids.map((k) => assign(k, depth + 1, false));
      const first = childCells[0].col;
      const last = childCells[childCells.length - 1].col;
      cell.col = (first + last) / 2;
    }
    return cell;
  }

  assign(displayRoot, 0, true);

  // Пиксельные координаты. Заодно ищем нижнюю кромку самого высокого узла —
  // полотно должно вместить выросшие по высоте пузыри.
  let maxBottom = 0;
  for (const cell of cells) {
    cell.cx = PAD + cell.col * H_GAP;
    cell.cy = PAD + cell.depth * V_GAP;
    const bottom = cell.cy + cell.h / 2;
    if (bottom > maxBottom) maxBottom = bottom;
  }

  // Связи (ортогональные «локти», сверху вниз, без стрелок). Концы — по
  // фактической высоте пузырей (у высоких — дальше от центра).
  const cellByNodeId = new Map<string, Cell>();
  for (const c of cells) cellByNodeId.set(c.node.id, c);
  for (const parent of cells) {
    const kids = visibleChildren(parent.node);
    for (const k of kids) {
      const child = cellByNodeId.get(k.id);
      if (!child) continue;
      const pBottom = parent.cy + parent.h / 2;
      const cTop = child.cy - child.h / 2;
      const midY = pBottom + (cTop - pBottom) / 2;
      const path = `M ${parent.cx} ${pBottom} V ${midY} H ${child.cx} V ${cTop}`;
      edges.push({ id: `${parent.node.id}->${k.id}`, path, deleted: k.isDeleted });
    }
  }

  const width = PAD * 2 + Math.max(0, nextCol - 1) * H_GAP + NODE_W;
  const height = maxBottom + PAD;
  return { cells, edges, width, height };
}

// --- отрисовка одного узла -------------------------------------------------

function markerText(m: TreeMarker): string {
  const comment = (m.comment ?? "").trim();
  return comment.length > 0 ? comment : m.label;
}

function NodeCell({
  cell,
  onClick,
  onDoubleClick,
  onOpenAttachment,
  onOpenArtifact,
}: {
  cell: Cell;
  onClick: (cell: Cell, e: React.MouseEvent) => void;
  onDoubleClick: (cell: Cell, e: React.MouseEvent) => void;
  onOpenAttachment: (cell: Cell, index: number) => void;
  onOpenArtifact: (cell: Cell) => void;
}): React.ReactElement {
  const { node, kind, cx, cy, h } = cell;
  const left = cx - NODE_W / 2;
  const top = cy - h / 2;
  const deletedClass = node.isDeleted ? " is-deleted" : "";

  // Узел-артефакт (файл, прикреплённый скрепкой) — пузырь-обложка с иконкой
  // внутри, как во всех остальных случаях. Клик по иконке открывает файл;
  // тело пузыря ведёт себя как обычный узел (ZOOM/навигация).
  if (kind === "artifact") {
    const art = parseArtifactExtra(node.extra);
    return (
      <div
        className={`tree-node tree-node--artifact${deletedClass}`}
        style={{ left, top, width: NODE_W, height: h }}
        title={node.content}
        onClick={(e) => onClick(cell, e)}
        onDoubleClick={(e) => onDoubleClick(cell, e)}
      >
        <div className="tree-node-attachments">
          <button
            type="button"
            className="tree-node-attachment"
            title={node.content}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpenArtifact(cell);
            }}
          >
            <MediaKindIcon kind={art?.mediaKind ?? "other"} />
          </button>
        </div>
      </div>
    );
  }

  // Корень (#0) — только маркер-чип, без прямоугольника-анкора (не кликабелен).
  if (kind === "root") {
    return (
      <div className="tree-node-group" style={{ left: cx, top }}>
        <MarkerChips markers={node.markers} fallbackLabel="#0" />
      </div>
    );
  }

  // Q / A / S / pending — прямоугольник; у A с маркерами — чипы над ним.
  const kindClass =
    kind === "q"
      ? "tree-node--q"
      : kind === "s"
        ? "tree-node--s"
        : kind === "pending"
          ? "tree-node--pending"
          : "tree-node--a";

  // Вложения внутри Q/A (extra.attachments) — иконки в правой части пузыря.
  const attachments =
    kind === "q" || kind === "a" ? parseMessageAttachments(node.extra) : [];

  return (
    <>
      {node.markers.length > 0 && (
        <div className="tree-node-group" style={{ left: cx, top: top - 4 }}>
          <MarkerChips markers={node.markers} anchorAbove />
        </div>
      )}
      <div
        className={`tree-node ${kindClass}${deletedClass}`}
        style={{ left, top, width: NODE_W, height: h }}
        title={node.content}
        onClick={(e) => onClick(cell, e)}
        onDoubleClick={(e) => onDoubleClick(cell, e)}
      >
        {attachments.length > 0 && (
          <div className="tree-node-attachments">
            {attachments.map((att, i) => (
              <button
                key={i}
                type="button"
                className="tree-node-attachment"
                title={att.filename}
                // Свой одиночный клик = открыть файл; глушим всплытие, чтобы не
                // сработал ZOOM/навигация пузыря и не запустилось панорамирование.
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenAttachment(cell, i);
                }}
              >
                <MediaKindIcon kind={att.mediaKind} />
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function zoomKindLabel(kind: CellKind): string {
  switch (kind) {
    case "q":
      return t("widgets.tree.kind.q");
    case "a":
      return t("widgets.tree.kind.a");
    case "s":
      return t("widgets.tree.kind.s");
    case "pending":
      return t("widgets.tree.kind.pending");
    default:
      return "";
  }
}

interface ZoomState {
  cell: Cell;
  x: number; // px относительно .tree-canvas
  y: number;
}

function MarkerChips({
  markers,
  fallbackLabel,
  anchorAbove,
}: {
  markers: TreeMarker[];
  fallbackLabel?: string;
  anchorAbove?: boolean;
}): React.ReactElement {
  const list =
    markers.length > 0
      ? markers
      : fallbackLabel
        ? [{ id: "fallback", label: fallbackLabel, comment: null }]
        : [];
  return (
    <div className={`tree-markers${anchorAbove ? " tree-markers--above" : ""}`}>
      {list.map((m) => (
        <span key={m.id} className="tree-marker" title={markerText(m)}>
          {markerText(m)}
        </span>
      ))}
    </div>
  );
}

// --- компонент -------------------------------------------------------------

export function TreeCanvas({
  doc,
  c,
}: {
  doc: TreeDoc;
  c: DialogController;
}): React.ReactElement {
  const { dialogId, closeTree } = c;
  const [nodes, setNodes] = useState<TreeNodeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<ZoomState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const singleClickTimer = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const panRef = useRef<{
    startX: number;
    startY: number;
    scrollL: number;
    scrollT: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!dialogId) {
      setNodes([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    invoke<RawTreeNode[]>("cmd_get_full_tree", { dialogId })
      .then((raw) => {
        if (cancelled) return;
        setNodes(raw.map(toTreeNode));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dialogId]);

  const layout = useMemo(
    () => buildLayout(nodes, doc.showDeleted, doc.showUnanswered),
    [nodes, doc.showDeleted, doc.showUnanswered],
  );

  const empty = !loading && !error && layout.cells.length <= 1;

  // Подсказка (напр. про удалённую ветку) — самогасящаяся.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(id);
  }, [notice]);

  // Esc закрывает ZOOM-карточку.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setZoom(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(
    () => () => {
      if (singleClickTimer.current) window.clearTimeout(singleClickTimer.current);
    },
    [],
  );

  // --- панорамирование зажатием мыши по полотну ----------------------------
  const onWinMouseMove = useCallback((e: MouseEvent) => {
    const pan = panRef.current;
    const body = bodyRef.current;
    if (!pan || !body) return;
    const dx = e.clientX - pan.startX;
    const dy = e.clientY - pan.startY;
    if (!pan.moved && Math.hypot(dx, dy) > 4) {
      pan.moved = true;
      setPanning(true);
      setZoom(null);
    }
    if (pan.moved) {
      body.scrollLeft = pan.scrollL - dx;
      body.scrollTop = pan.scrollT - dy;
    }
  }, []);

  const onWinMouseUp = useCallback(() => {
    const pan = panRef.current;
    if (pan?.moved) {
      // Подавляем клик, который браузер отправит после перетаскивания.
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    panRef.current = null;
    setPanning(false);
    window.removeEventListener("mousemove", onWinMouseMove);
    window.removeEventListener("mouseup", onWinMouseUp);
  }, [onWinMouseMove]);

  const onBodyMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const body = bodyRef.current;
      if (!body) return;
      setZoom(null);
      panRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        scrollL: body.scrollLeft,
        scrollT: body.scrollTop,
        moved: false,
      };
      window.addEventListener("mousemove", onWinMouseMove);
      window.addEventListener("mouseup", onWinMouseUp);
    },
    [onWinMouseMove, onWinMouseUp],
  );

  // --- клики по узлам -------------------------------------------------------
  const handleNodeClick = useCallback((cell: Cell, e: React.MouseEvent) => {
    if (suppressClickRef.current) return;
    // ZOOM с задержкой, чтобы уступить возможному двойному клику. Иконка
    // артефакта/вложения открывается своим обработчиком (stopPropagation),
    // до тела пузыря клик не доходит.
    const rect = canvasRef.current?.getBoundingClientRect();
    const x = rect ? e.clientX - rect.left : e.clientX;
    const y = rect ? e.clientY - rect.top : e.clientY;
    if (singleClickTimer.current) window.clearTimeout(singleClickTimer.current);
    singleClickTimer.current = window.setTimeout(() => {
      setZoom({ cell, x, y });
      singleClickTimer.current = null;
    }, 220);
  }, []);

  const handleOpenAttachment = useCallback(
    (cell: Cell, index: number) => {
      void c.openMessageAttachment(cell.node.id, index);
    },
    [c],
  );

  const handleOpenArtifact = useCallback(
    (cell: Cell) => {
      void c.openArtifact(cell.node.id);
    },
    [c],
  );

  const handleNodeDoubleClick = useCallback(
    (cell: Cell) => {
      if (singleClickTimer.current) {
        window.clearTimeout(singleClickTimer.current);
        singleClickTimer.current = null;
      }
      const { node } = cell;
      if (node.isDeleted) {
        setNotice(t("widgets.tree.deletedNav"));
        return;
      }
      setZoom(null);
      void c.navigateToTreeNode(node.id);
    },
    [c],
  );

  // Позиция ZOOM-карточки с зажимом в границах полотна.
  const zoomPos = (() => {
    if (!zoom) return null;
    const cardW = 320;
    const cardH = 240;
    const cw = canvasRef.current?.clientWidth ?? 0;
    const chh = canvasRef.current?.clientHeight ?? 0;
    let zx = zoom.x + 14;
    let zy = zoom.y + 14;
    if (cw && zx + cardW > cw) zx = Math.max(8, zoom.x - cardW - 14);
    if (chh && zy + cardH > chh) zy = Math.max(8, chh - cardH - 8);
    return { zx, zy, cardW, cardH };
  })();

  return (
    <div
      className="tree-canvas"
      ref={canvasRef}
      role="dialog"
      aria-label={t("widgets.tree.title")}
    >
      <div className="tree-canvas-head">
        <h2 className="tree-canvas-title">{t("widgets.tree.title")}</h2>
        <button
          className="tree-canvas-close"
          onClick={closeTree}
          title={t("app.help.closeTitle")}
        >
          ✕ {t("common.close")}
        </button>
      </div>
      <div
        className={`tree-canvas-body${panning ? " is-panning" : ""}`}
        ref={bodyRef}
        onMouseDown={onBodyMouseDown}
      >
        {loading && <div className="tree-canvas-status">{t("common.loading")}</div>}
        {error && (
          <div className="tree-canvas-status tree-canvas-error">{error}</div>
        )}
        {empty && (
          <div className="tree-canvas-status">{t("widgets.tree.empty")}</div>
        )}
        {!loading && !error && !empty && (
          <div
            className="tree-plane"
            style={{ width: layout.width, height: layout.height }}
          >
            <svg
              className="tree-edges"
              width={layout.width}
              height={layout.height}
              style={{ position: "absolute", left: 0, top: 0 }}
            >
              {layout.edges.map((e) => (
                <path
                  key={e.id}
                  d={e.path}
                  className={`tree-edge${e.deleted ? " is-deleted" : ""}`}
                  fill="none"
                />
              ))}
            </svg>
            {layout.cells.map((cell) => (
              <NodeCell
                key={cell.node.id}
                cell={cell}
                onClick={handleNodeClick}
                onDoubleClick={handleNodeDoubleClick}
                onOpenAttachment={handleOpenAttachment}
                onOpenArtifact={handleOpenArtifact}
              />
            ))}
          </div>
        )}
      </div>

      {zoom && zoomPos && (
        <div
          className="tree-zoom"
          style={{
            left: zoomPos.zx,
            top: zoomPos.zy,
            width: zoomPos.cardW,
            maxHeight: zoomPos.cardH,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="tree-zoom-head">
            <span className="tree-zoom-kind">{zoomKindLabel(zoom.cell.kind)}</span>
            {zoom.cell.kind === "a" &&
              doc.showModelInZoom &&
              zoom.cell.node.modelId && (
                <span className="tree-zoom-model">
                  {resolveModelName(zoom.cell.node.modelId)}
                </span>
              )}
            <button
              className="tree-zoom-close"
              onClick={() => setZoom(null)}
              title={t("common.close")}
            >
              ✕
            </button>
          </div>
          <div className="tree-zoom-body">
            {zoom.cell.node.content.trim().length > 0 ? (
              <pre className="tree-zoom-text">{zoom.cell.node.content}</pre>
            ) : (
              <span className="tree-zoom-empty">{t("widgets.tree.noText")}</span>
            )}
          </div>
        </div>
      )}

      {notice && <div className="tree-notice">{notice}</div>}
    </div>
  );
}
