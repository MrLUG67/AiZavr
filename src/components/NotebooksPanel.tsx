// Левая панель «Блокноты»: дерево блокнотов и бесед — организатор рабочего
// пространства (concept 3.6). Хром (show/hide, ширина, прокрутка) — прежний.
//
// Данные дерева (блокноты + беседы) принадлежат App (единый источник правды —
// его же читает шапка беседы). Панель владеет только UI-состоянием: раскрытие
// веток (персист в localStorage — переживает перезагрузку), меню, инлайн-ввод.
// Структурные операции (создание/удаление/перенос) зовут cmd_* и просят App
// перечитать дерево; переименование беседы — точечный патч (мгновенно, без
// перестроения: раскрытое остаётся раскрытым).
//
// Это ХРОМ ЯДРА, поэтому ходит в cmd_* напрямую (как App.tsx), а не через
// капабилити плагинов.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t, useLang } from "../i18n";

const LS_OPEN = "aizavr.notebooks.open";
const LS_WIDTH = "aizavr.notebooks.width";
const LS_EXPANDED = "aizavr.notebooks.expanded";

const WIDTH_MIN = 180;
const WIDTH_MAX = 480;
const WIDTH_DEFAULT = 260;

const ROOT_ID = "root";

interface Notebook {
  id: string;
  parent_notebook_id: string | null;
  name: string;
  kind: string; // root | trash | normal
}

interface Dialog {
  id: string;
  notebook_id: string | null;
  title: string;
}

// Подбор тега в поиске: тег справочника + число помеченных им бесед.
interface TagHit {
  id: string;
  name: string;
  display_name: string;
  dialog_count: number;
}

interface NotebooksPanelProps {
  notebooks: Notebook[];
  dialogs: Dialog[];
  activeDialogId: string | null;
  onOpenDialog: (dialogId: string | null) => void;
  reloadTree: () => Promise<void>;
  patchDialogTitle: (id: string, title: string) => void;
}

type DragItem = { kind: "notebook" | "dialog"; id: string };

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function readNum(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function readExpanded(): Set<string> {
  try {
    const v = localStorage.getItem(LS_EXPANDED);
    if (v) return new Set(JSON.parse(v) as string[]);
  } catch {}
  return new Set([ROOT_ID]);
}

export function NotebooksPanel({
  notebooks,
  dialogs,
  activeDialogId,
  onOpenDialog,
  reloadTree,
  patchDialogTitle,
}: NotebooksPanelProps): React.ReactElement {
  useLang(); // перерисовка при смене языка
  const [open, setOpen] = useState(() => readBool(LS_OPEN, true));
  const [width, setWidth] = useState(() => readNum(LS_WIDTH, WIDTH_DEFAULT));

  // Раскрытие веток — персистентно, чтобы не сворачивалось при перезагрузке.
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const [err, setErr] = useState<string | null>(null);

  // Инлайн-создание блокнота: id родителя, внутри которого вводим имя.
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  // Инлайн-переименование блокнота / беседы (делят поле ввода renameText —
  // одновременно активно только одно).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingDialogId, setRenamingDialogId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  // Меню «⋮» / ПКМ открытого блокнота/беседы.
  const [menuId, setMenuId] = useState<string | null>(null);

  // Подсветка цели при перетаскивании.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragRef = useRef<DragItem | null>(null);

  // --- Поиск бесед по тегам (нижняя секция) ---
  // Запрос всегда управляет подбором тегов; выбор тега проваливает в список
  // бесед. Сброс — только по X. Клик по беседе не сбрасывает поиск.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchView, setSearchView] = useState<"tags" | "dialogs">("tags");
  const [matchedTags, setMatchedTags] = useState<TagHit[]>([]);
  const [selectedTag, setSelectedTag] = useState<TagHit | null>(null);
  const [matchedDialogs, setMatchedDialogs] = useState<Dialog[]>([]);
  const searchReqRef = useRef(0);

  useEffect(() => { try { localStorage.setItem(LS_OPEN, open ? "1" : "0"); } catch {} }, [open]);
  useEffect(() => { try { localStorage.setItem(LS_WIDTH, String(width)); } catch {} }, [width]);
  useEffect(() => {
    try { localStorage.setItem(LS_EXPANDED, JSON.stringify([...expanded])); } catch {}
  }, [expanded]);

  // Подбор тегов: динамически на каждое изменение запроса, если значимых
  // символов больше двух. Любая правка запроса возвращает к перечню тегов
  // (выбранный тег сбрасывается) и сужает список с каждым символом.
  useEffect(() => {
    const q = searchQuery.trim().replace(/^#+/, "");
    if (q.length <= 2) {
      setMatchedTags([]);
      setSearchView("tags");
      setSelectedTag(null);
      return;
    }
    const myId = ++searchReqRef.current;
    const handle = window.setTimeout(async () => {
      try {
        const hits = await invoke<TagHit[]>("cmd_search_dialog_tags", { query: q });
        if (myId !== searchReqRef.current) return;
        setMatchedTags(hits);
        setSearchView("tags");
        setSelectedTag(null);
      } catch (e) {
        console.error("search_dialog_tags failed:", e);
      }
    }, 150);
    return () => window.clearTimeout(handle);
  }, [searchQuery]);

  async function pickSearchTag(tag: TagHit) {
    setSelectedTag(tag);
    setSearchView("dialogs");
    try {
      const dls = await invoke<Dialog[]>("cmd_list_dialogs_by_tag", { tagId: tag.id });
      setMatchedDialogs(dls);
    } catch (e) {
      console.error("list_dialogs_by_tag failed:", e);
      setMatchedDialogs([]);
    }
  }

  function backToTags() {
    setSearchView("tags");
    setSelectedTag(null);
    setMatchedDialogs([]);
  }

  function clearSearch() {
    searchReqRef.current++;
    setSearchQuery("");
    setSearchView("tags");
    setSelectedTag(null);
    setMatchedTags([]);
    setMatchedDialogs([]);
  }

  // Индексы дерева: дети-блокноты и беседы по блокноту.
  const childNotebooks = (parentId: string): Notebook[] =>
    notebooks
      .filter((n) => n.parent_notebook_id === parentId)
      // нормальные блокноты по алфавиту, служебные (корзина) — в конец
      .sort((a, b) => {
        if (a.kind !== "normal" && b.kind === "normal") return 1;
        if (a.kind === "normal" && b.kind !== "normal") return -1;
        return a.name.localeCompare(b.name);
      });

  const notebookDialogs = (notebookId: string): Dialog[] =>
    dialogs.filter((d) => d.notebook_id === notebookId);

  const root = notebooks.find((n) => n.id === ROOT_ID) ?? null;

  // --- мутации ---

  // Для операций, возвращающих значение (create): объект или null при ошибке.
  async function run<T>(p: Promise<T>): Promise<T | null> {
    try {
      const r = await p;
      setErr(null);
      return r;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  // Для void-операций (rename/delete/move): true при успехе. Нельзя судить по
  // результату invoke — команды отдают unit (), который резолвится в null.
  async function runVoid(p: Promise<unknown>): Promise<boolean> {
    try {
      await p;
      setErr(null);
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function beginCreate(parentId: string) {
    setMenuId(null);
    setExpanded((prev) => new Set(prev).add(parentId));
    setCreatingIn(parentId);
    setNewName("");
  }

  async function commitCreate() {
    const parentId = creatingIn;
    const name = newName.trim();
    setCreatingIn(null);
    setNewName("");
    if (!parentId || !name) return;
    const nb = await run(
      invoke<Notebook>("cmd_create_notebook", { parentId, name }),
    );
    if (nb) await reloadTree();
  }

  async function createDialog(notebookId: string) {
    setMenuId(null);
    const d = await run(
      invoke<Dialog>("cmd_create_dialog_in_notebook", {
        notebookId,
        title: t("notebooks.newDialogTitle"),
        rootMarkerComment: t("app.marker.rootDefault"),
      }),
    );
    if (d) {
      setExpanded((prev) => new Set(prev).add(notebookId));
      await reloadTree();
      onOpenDialog(d.id);
    }
  }

  function beginRename(nb: Notebook) {
    setMenuId(null);
    setRenamingDialogId(null);
    setRenamingId(nb.id);
    setRenameText(nb.name);
  }

  async function commitRename() {
    const id = renamingId;
    const name = renameText.trim();
    setRenamingId(null);
    setRenameText("");
    if (!id || !name) return;
    if (await runVoid(invoke("cmd_rename_notebook", { notebookId: id, name }))) {
      await reloadTree();
    }
  }

  function beginRenameDialog(d: Dialog) {
    setMenuId(null);
    setRenamingId(null);
    setRenamingDialogId(d.id);
    setRenameText(d.title);
  }

  async function commitRenameDialog() {
    const id = renamingDialogId;
    const title = renameText.trim();
    setRenamingDialogId(null);
    setRenameText("");
    if (!id || !title) return;
    // Точечный патч общего списка: мгновенно и без перестроения дерева.
    if (await runVoid(invoke("cmd_update_dialog_title", { dialogId: id, title }))) {
      patchDialogTitle(id, title);
    }
  }

  async function deleteNotebook(id: string) {
    setMenuId(null);
    if (await runVoid(invoke("cmd_delete_notebook", { notebookId: id }))) {
      await reloadTree();
    }
  }

  async function deleteDialog(id: string) {
    setMenuId(null);
    if (await runVoid(invoke("cmd_delete_dialog", { dialogId: id }))) {
      if (activeDialogId === id) onOpenDialog(null);
      await reloadTree();
    }
  }

  // --- drag & drop (переподчинение) ---

  function onDropInto(targetNotebookId: string) {
    const item = dragRef.current;
    dragRef.current = null;
    setDropTarget(null);
    if (!item) return;
    (async () => {
      if (item.kind === "notebook") {
        if (item.id === targetNotebookId) return;
        if (
          await runVoid(
            invoke("cmd_move_notebook", {
              notebookId: item.id,
              newParentId: targetNotebookId,
            }),
          )
        ) {
          await reloadTree();
        }
      } else {
        if (
          await runVoid(
            invoke("cmd_move_dialog", {
              dialogId: item.id,
              newNotebookId: targetNotebookId,
            }),
          )
        ) {
          await reloadTree();
        }
      }
    })();
  }

  // --- рендер свёрнутого состояния ---

  if (!open) {
    return (
      <div className="notebooks-rail">
        <button
          className="notebooks-rail-expand"
          title={t("notebooks.show")}
          onClick={() => setOpen(true)}
        >
          ▶
        </button>
        <span className="notebooks-rail-label">{t("notebooks.title")}</span>
      </div>
    );
  }

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, startW + (ev.clientX - startX)));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Рекурсивный рендер блокнота.
  function renderNotebook(nb: Notebook, depth: number): React.ReactNode {
    const isRoot = nb.kind === "root";
    const isTrash = nb.kind === "trash";
    const isSystem = isRoot || isTrash;
    const isOpen = expanded.has(nb.id);
    const kids = childNotebooks(nb.id);
    const dls = notebookDialogs(nb.id);
    const hasContent = kids.length > 0 || dls.length > 0;

    return (
      <div key={nb.id} className="nb-node">
        <div
          className={`nb-row nb-row--notebook ${isSystem ? "nb-row--system" : ""} ${
            dropTarget === nb.id ? "nb-row--droptarget" : ""
          }`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={!isSystem}
          onDragStart={(e) => {
            if (isSystem) return;
            dragRef.current = { kind: "notebook", id: nb.id };
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", nb.id);
          }}
          onDragOver={(e) => {
            if (isTrash) return; // в корзину тащить нельзя — там удаление через меню
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(nb.id);
          }}
          onDragLeave={() => setDropTarget((t) => (t === nb.id ? null : t))}
          onDrop={(e) => {
            if (isTrash) return;
            e.preventDefault();
            onDropInto(nb.id);
          }}
        >
          <button
            className="nb-twisty"
            onClick={() => toggle(nb.id)}
            title={isOpen ? t("common.collapse") : t("common.expand")}
            style={{ visibility: hasContent ? "visible" : "hidden" }}
          >
            {isOpen ? "▾" : "▸"}
          </button>

          <span className="nb-icon">{isTrash ? "🗑" : isRoot ? "★" : "📁"}</span>

          {renamingId === nb.id ? (
            <input
              className="nb-edit"
              autoFocus
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                else if (e.key === "Escape") { e.preventDefault(); setRenamingId(null); }
              }}
              onBlur={commitRename}
            />
          ) : (
            <span className="nb-name" onClick={() => toggle(nb.id)} title={nb.name}>
              {nb.name}
            </span>
          )}

          {!isTrash && (
            <span className={`nb-actions ${menuId === nb.id ? "nb-actions--open" : ""}`}>
              <button
                className="nb-act"
                title={t("notebooks.newChild")}
                onClick={(e) => { e.stopPropagation(); beginCreate(nb.id); }}
              >
                📁+
              </button>
              {!isRoot && (
                <button
                  className="nb-act"
                  title={t("notebooks.newDialog")}
                  onClick={(e) => { e.stopPropagation(); createDialog(nb.id); }}
                >
                  💬+
                </button>
              )}
              {!isSystem && (
                <button
                  className="nb-act"
                  title={t("notebooks.notebookMenu")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuId(menuId === nb.id ? null : nb.id);
                  }}
                >
                  ⋮
                </button>
              )}
              {menuId === nb.id && (
                <div className="nb-menu" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => beginRename(nb)}>{t("common.rename")}</button>
                  <button className="nb-menu-danger" onClick={() => deleteNotebook(nb.id)}>
                    {t("notebooks.deleteToTrash")}
                  </button>
                </div>
              )}
            </span>
          )}
        </div>

        {isOpen && (
          <>
            {creatingIn === nb.id && (
              <div className="nb-row nb-row--create" style={{ paddingLeft: 6 + (depth + 1) * 14 }}>
                <span className="nb-icon">📁</span>
                <input
                  className="nb-edit"
                  autoFocus
                  placeholder={t("notebooks.namePlaceholder")}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitCreate(); }
                    else if (e.key === "Escape") { e.preventDefault(); setCreatingIn(null); }
                  }}
                  onBlur={commitCreate}
                />
              </div>
            )}

            {kids.map((k) => renderNotebook(k, depth + 1))}

            {dls.map((d) => {
              const editing = renamingDialogId === d.id;
              return (
                <div
                  key={d.id}
                  className={`nb-row nb-row--dialog ${
                    activeDialogId === d.id ? "nb-row--active" : ""
                  }`}
                  style={{ paddingLeft: 6 + (depth + 1) * 14 }}
                  tabIndex={0}
                  draggable={!editing}
                  onDragStart={(e) => {
                    // Беседу можно перетащить всегда — в т.ч. вытащить из корзины
                    // в обычный блокнот (фактическое восстановление).
                    dragRef.current = { kind: "dialog", id: d.id };
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", d.id);
                  }}
                  onClick={() => { if (!editing) onOpenDialog(d.id); }}
                  onKeyDown={(e) => {
                    // F2 на сфокусированной беседе — редактировать имя.
                    if (e.key === "F2" && !editing) { e.preventDefault(); beginRenameDialog(d); }
                  }}
                  onContextMenu={(e) => {
                    // ПКМ по беседе — контекстное меню (Переименовать / Удалить).
                    e.preventDefault();
                    setMenuId(menuId === d.id ? null : d.id);
                  }}
                >
                  <span className="nb-icon nb-icon--dialog">💬</span>
                  {editing ? (
                    <input
                      className="nb-edit"
                      autoFocus
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitRenameDialog(); }
                        else if (e.key === "Escape") { e.preventDefault(); setRenamingDialogId(null); }
                      }}
                      onBlur={commitRenameDialog}
                    />
                  ) : (
                    <span className="nb-name" title={d.title}>{d.title || t("common.untitled")}</span>
                  )}
                  <span className={`nb-actions ${menuId === d.id ? "nb-actions--open" : ""}`}>
                    <button
                      className="nb-act"
                      title={t("notebooks.dialogMenu")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuId(menuId === d.id ? null : d.id);
                      }}
                    >
                      ⋮
                    </button>
                    {menuId === d.id && (
                      <div className="nb-menu" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => beginRenameDialog(d)}>{t("common.rename")}</button>
                        {!isTrash && (
                          <button className="nb-menu-danger" onClick={() => deleteDialog(d.id)}>
                            {t("notebooks.deleteToTrash")}
                          </button>
                        )}
                      </div>
                    )}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  }

  return (
    <aside className="notebooks-panel" style={{ width }}>
      <header className="notebooks-head">
        <span className="notebooks-title">{t("notebooks.title")}</span>
        <button
          className="notebooks-collapse"
          title={t("notebooks.newTop")}
          onClick={() => beginCreate(ROOT_ID)}
        >
          ＋
        </button>
        <button
          className="notebooks-collapse"
          title={t("notebooks.hide")}
          onClick={() => setOpen(false)}
        >
          ◀
        </button>
      </header>

      {err && (
        <div className="nb-error" role="alert">
          <span>⚠ {err}</span>
          <button onClick={() => setErr(null)} title={t("common.hide")}>×</button>
        </div>
      )}

      <div className="notebooks-body" onClick={() => setMenuId(null)}>
        {root ? (
          renderNotebook(root, 0)
        ) : (
          <p className="notebooks-empty">{t("notebooks.loading")}</p>
        )}
      </div>

      <div className="notebooks-search">
        {searchView === "dialogs" ? (
          <div className="nb-search-results">
            <button
              className="nb-search-back"
              onClick={backToTags}
              title={t("notebooks.search.back")}
            >
              ← #{selectedTag?.display_name}
            </button>
            {matchedDialogs.length > 0 ? (
              matchedDialogs.map((d) => (
                <div
                  key={d.id}
                  className={`nb-search-dialog ${
                    activeDialogId === d.id ? "nb-search-dialog--active" : ""
                  }`}
                  onClick={() => onOpenDialog(d.id)}
                  title={d.title}
                >
                  <span className="nb-icon nb-icon--dialog">💬</span>
                  <span className="nb-name">{d.title || t("common.untitled")}</span>
                </div>
              ))
            ) : (
              <div className="nb-search-empty">{t("notebooks.search.noDialogs")}</div>
            )}
          </div>
        ) : searchQuery.trim().replace(/^#+/, "").length > 2 ? (
          <div className="nb-search-results">
            {matchedTags.length > 0 ? (
              <div className="nb-search-tags">
                {matchedTags.map((tag) => (
                  <button
                    key={tag.id}
                    className="nb-search-tag"
                    onClick={() => pickSearchTag(tag)}
                  >
                    #{tag.display_name}
                    <span className="nb-search-count">{tag.dialog_count}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="nb-search-empty">{t("notebooks.search.noTags")}</div>
            )}
          </div>
        ) : null}

        <div className="nb-search-input-wrap">
          <input
            className="nb-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("notebooks.search.placeholder")}
          />
          {searchQuery && (
            <button
              className="nb-search-clear"
              onClick={clearSearch}
              title={t("notebooks.search.clear")}
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="notebooks-resizer" onPointerDown={onResizeStart} />
    </aside>
  );
}
