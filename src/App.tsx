import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  nodeId: string;
  childrenCount: number;         // total, включая удалённые
  deletedChildrenCount: number;  // только удалённые (D-050)
}

interface DbDialog {
  id: string;
  title: string;
  root_node_id: string | null;
  active_leaf_id: string | null;
}

interface DbNode {
  id: string;
  parent_id: string | null;
  dialog_id: string;
  node_type: string;
  content: string;
  active_child_id: string | null;
  children_count: number;
  branch_name: string | null;
  last_visited_leaf_id: string | null;
  is_deleted: boolean;
}

interface DepthIndicators {
  depth_left: number;
  branches_right: number;
}

interface BranchResult {
  new_node_id: string;
  dialog_id: string;
}

interface BranchCard {
  nodeId: string;
  branchName: string;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [dialogId, setDialogId] = useState<string | null>(null);
  const [lastNodeId, setLastNodeId] = useState<string | null>(null);
  const [depth, setDepth] = useState<DepthIndicators>({ depth_left: 0, branches_right: 0 });

  // Ветвление
  const [branchingFromId, setBranchingFromId] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState("");

  // Режим развилки
  const [forkMode, setForkMode] = useState(false);
  const [forkNodeId, setForkNodeId] = useState<string | null>(null);
  const [forkCards, setForkCards] = useState<BranchCard[]>([]);
  const [forkActiveIdx, setForkActiveIdx] = useState(0);
  const cardsRef = useRef<HTMLDivElement>(null);

  // Режим восстановления удалённых веток (D-050)
  const [deletedMode, setDeletedMode] = useState(false);
  const [deletedForkNodeId, setDeletedForkNodeId] = useState<string | null>(null);
  const [deletedForkCards, setDeletedForkCards] = useState<BranchCard[]>([]);

  const messagesRef = useRef<HTMLDivElement>(null);
  const messageEls = useRef<(HTMLDivElement | null)[]>([]);

  // Редактирование имени карточки
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [menuNodeId, setMenuNodeId] = useState<string | null>(null);
  const clickTimer = useRef<number | null>(null);

  // API key
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState("");

  const MODEL = "anthropic/claude-haiku-4-5";

  // ---------------------------------------------------------------------------
  // Инициализация
  // ---------------------------------------------------------------------------

  useEffect(() => {
    async function init() {
      const key = await invoke<string | null>("cmd_get_api_key", { providerId: "openrouter" });
      if (!key) { setHasApiKey(false); return; }
      setHasApiKey(true);
      await initDialog();
    }
    init().catch(console.error);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (editingNodeId) return;

      if (e.key === "F2" && forkMode) {
        e.preventDefault();
        const card = forkCards[forkActiveIdx];
        if (card) startEditing(card.nodeId);
        return;
      }

      if (e.key === "Enter" && forkMode) {
        e.preventDefault();
        selectForkCard(forkActiveIdx);
        return;
      }

      if (!e.ctrlKey) return;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        handleCtrlUp();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        handleCtrlDown();
      } else if (e.key === "ArrowLeft" && forkMode) {
        e.preventDefault();
        setForkActiveIdx(i => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight" && forkMode) {
        e.preventDefault();
        setForkActiveIdx(i => Math.min(forkCards.length - 1, i + 1));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [forkMode, forkCards, forkActiveIdx, messages, dialogId, editingNodeId]);

  useEffect(() => {
    const el = cardsRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      el!.scrollLeft += e.deltaY;
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [forkMode]);

  // ---------------------------------------------------------------------------
  // Диалог
  // ---------------------------------------------------------------------------

  async function initDialog() {
    const dialogs = await invoke<DbDialog[]>("cmd_list_dialogs");
    if (dialogs.length > 0) {
      const d = dialogs[0];
      setDialogId(d.id);
      await loadBranch(d.id);
    } else {
      const d = await invoke<DbDialog>("cmd_create_dialog", { title: "New conversation", notebookId: null });
      setDialogId(d.id);
    }
  }

  async function loadBranch(dId: string) {
    const branch = await invoke<DbNode[]>("cmd_get_branch", { dialogId: dId });

    // Для каждого A-узла параллельно подгружаем количество удалённых веток
    const restored: Message[] = await Promise.all(
      branch
        .filter(n => n.node_type === "user_message" || n.node_type === "assistant_message")
        .map(async (n) => {
          let deletedCount = 0;
          if (n.node_type === "assistant_message") {
            const deleted = await invoke<DbNode[]>("cmd_get_deleted_children", { nodeId: n.id });
            deletedCount = deleted.length;
          }
          return {
            role: n.node_type === "user_message" ? "user" : "assistant" as "user" | "assistant",
            content: n.content,
            nodeId: n.id,
            childrenCount: n.children_count,
            deletedChildrenCount: deletedCount,
          };
        })
    );

    setMessages(restored);

    if (branch.length > 0) {
      setLastNodeId(branch[branch.length - 1].id);
    }

    const indicators = await invoke<DepthIndicators>("cmd_get_depth_indicators", { dialogId: dId });
    setDepth(indicators);
  }

  // ---------------------------------------------------------------------------
  // Режим развилки
  // ---------------------------------------------------------------------------

  async function openForkMode(aNodeId: string) {
    // Закрываем режим восстановления если был открыт
    setDeletedMode(false);
    setDeletedForkNodeId(null);
    setDeletedForkCards([]);

    const children = await invoke<DbNode[]>("cmd_get_children", { nodeId: aNodeId });
    const aNode = await invoke<DbNode | null>("cmd_get_node", { nodeId: aNodeId });

    const cards: BranchCard[] = children.map(c => ({
      nodeId: c.id,
      branchName: c.branch_name ?? c.content.slice(0, 80),
      isActive: aNode?.active_child_id === c.id,
    }));

    const activeIdx = cards.findIndex(c => c.isActive);
    setForkCards(cards);
    setForkActiveIdx(activeIdx >= 0 ? activeIdx : 0);
    setForkNodeId(aNodeId);
    setForkMode(true);
  }

  async function closeForkMode() {
    if (clickTimer.current !== null) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    setForkMode(false);
    setForkNodeId(null);
    setForkCards([]);
    setEditingNodeId(null);
    setEditingText("");
    setMenuNodeId(null);
  }

  // ---------------------------------------------------------------------------
  // Режим восстановления удалённых веток (D-050)
  // ---------------------------------------------------------------------------

  async function openDeletedMode(aNodeId: string) {
    // Закрываем режим развилки если был открыт
    await closeForkMode();

    const deleted = await invoke<DbNode[]>("cmd_get_deleted_children", { nodeId: aNodeId });
    const cards: BranchCard[] = deleted.map(c => ({
      nodeId: c.id,
      branchName: c.branch_name ?? c.content.slice(0, 80),
      isActive: false,
    }));

    setDeletedForkCards(cards);
    setDeletedForkNodeId(aNodeId);
    setDeletedMode(true);
  }

  function closeDeletedMode() {
    setDeletedMode(false);
    setDeletedForkNodeId(null);
    setDeletedForkCards([]);
  }

  async function restoreBranch(nodeId: string) {
    if (!dialogId) return;
    try {
      await invoke("cmd_restore_branch", { nodeId });
    } catch (e) {
      console.error("restore_branch failed:", e);
      return;
    }
    closeDeletedMode();
    await loadBranch(dialogId);
  }

  // ---------------------------------------------------------------------------
  // Удаление ветки из меню карточки (D-048, D-049)
  // ---------------------------------------------------------------------------

  async function deleteCardBranch(childId: string) {
    if (!dialogId || !forkNodeId) return;
    setMenuNodeId(null);
    try {
      await invoke("cmd_delete_branch", { dialogId, forkNodeId, childId });
    } catch (e) {
      // Сюда попадаем если пытаемся удалить последнюю видимую ветку —
      // backend вернёт "cannot delete last visible branch"
      console.error("delete_branch failed:", e);
      return;
    }
    // Перезагружаем fork mode и ветку
    await openForkMode(forkNodeId);
    await loadBranch(dialogId);
  }

  // ---------------------------------------------------------------------------
  // Выбор карточки
  // ---------------------------------------------------------------------------

  async function selectForkCard(idx: number) {
    if (!dialogId || !forkNodeId) return;
    const card = forkCards[idx];
    if (!card) return;

    try {
      await invoke("cmd_select_branch", {
        dialogId,
        forkNodeId,
        childId: card.nodeId,
      });
    } catch (e) {
      console.error("select_branch failed:", e);
    }

    await closeForkMode();
    await loadBranch(dialogId);
  }

  // ---------------------------------------------------------------------------
  // Редактирование имени карточки
  // ---------------------------------------------------------------------------

  function startEditing(nodeId: string) {
    const card = forkCards.find(c => c.nodeId === nodeId);
    if (!card) return;
    setMenuNodeId(null);
    setEditingNodeId(nodeId);
    setEditingText(card.branchName);
  }

  function cancelEditing() {
    setEditingNodeId(null);
    setEditingText("");
  }

  async function saveEditing() {
    if (!editingNodeId) return;
    const name = editingText.trim();
    if (!name) { cancelEditing(); return; }

    try {
      await invoke("cmd_set_branch_name", { nodeId: editingNodeId, name });
      setForkCards(cards =>
        cards.map(c => (c.nodeId === editingNodeId ? { ...c, branchName: name } : c))
      );
    } catch (e) {
      console.error("set_branch_name failed:", e);
    }
    cancelEditing();
  }

  function handleCardClick(idx: number) {
    if (clickTimer.current !== null) {
      clearTimeout(clickTimer.current);
    }
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      selectForkCard(idx);
    }, 220);
  }

  function handleCardDoubleClick(nodeId: string) {
    if (clickTimer.current !== null) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    startEditing(nodeId);
  }

  // ---------------------------------------------------------------------------
  // Навигация
  // ---------------------------------------------------------------------------

  // Ctrl+Up — ищем развилку с > 1 ВИДИМЫХ веток (D-049: удалённые не в счёт)
  function handleCtrlUp() {
    if (forkMode) return;
    const container = messagesRef.current;
    if (!container) return;

    const containerTop = container.getBoundingClientRect().top;
    const viewportHeight = container.clientHeight;

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const visibleCount = m.childrenCount - m.deletedChildrenCount;
      if (visibleCount <= 1) continue;
      const el = messageEls.current[i];
      if (!el) continue;
      const relTop = el.getBoundingClientRect().top - containerTop;
      if (relTop < viewportHeight) {
        openForkMode(m.nodeId);
        return;
      }
    }

    container.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleCtrlDown() {
    if (forkMode) selectForkCard(forkActiveIdx);
  }

  // ---------------------------------------------------------------------------
  // Отправка сообщений
  // ---------------------------------------------------------------------------

  async function saveApiKey() {
    setKeyError("");
    const trimmed = keyInput.trim();
    if (!trimmed) { setKeyError("Key cannot be empty."); return; }
    try {
      await invoke("cmd_set_api_key", { providerId: "openrouter", apiKey: trimmed });
      setHasApiKey(true);
      setKeyInput("");
      await initDialog();
    } catch (e) {
      setKeyError(`Failed to save key: ${e}`);
    }
  }

  async function sendMessage() {
    if (!input.trim() || loading || !dialogId) return;
    const userText = input.trim();
    setInput("");
    setLoading(true);
    await doSend(dialogId, lastNodeId, userText);
    setLoading(false);
  }

  async function sendBranch() {
    if (!branchInput.trim() || loading || !dialogId || !branchingFromId) return;
    const userText = branchInput.trim();
    setBranchInput("");
    setBranchingFromId(null);
    setLoading(true);

    const result = await invoke<BranchResult>("cmd_branch_from_node", {
      dialogId,
      parentId: branchingFromId,
      content: userText,
    });

    await loadBranch(dialogId);

    const branch = await invoke<DbNode[]>("cmd_get_branch", { dialogId });
    const llmMessages: LlmMessage[] = branch
      .filter(n => n.node_type === "user_message" || n.node_type === "assistant_message")
      .map(n => ({ role: n.node_type === "user_message" ? "user" : "assistant", content: n.content }));

    try {
      const response = await invoke<string>("send_message", { messages: llmMessages, modelId: MODEL });
      await invoke<DbNode>("cmd_create_node", {
        dialogId,
        parentId: result.new_node_id,
        nodeType: "assistant_message",
        content: response,
        modelId: MODEL,
        modelRole: "main_dialog",
        tokensCount: 0,
      });
      await loadBranch(dialogId);
    } catch (e) {
      await invoke<DbNode>("cmd_create_node", {
        dialogId,
        parentId: result.new_node_id,
        nodeType: "assistant_message",
        content: `Error: ${e}`,
        modelId: null,
        modelRole: null,
        tokensCount: 0,
      });
      await loadBranch(dialogId);
    } finally {
      setLoading(false);
    }
  }

  async function doSend(dId: string, parentId: string | null, userText: string) {
    const userNode = await invoke<DbNode>("cmd_create_node", {
      dialogId: dId,
      parentId,
      nodeType: "user_message",
      content: userText,
      modelId: null,
      modelRole: null,
      tokensCount: 0,
    });

	const updatedMessages: Message[] = [
	  ...messages.map(m =>
		m.nodeId === parentId
		  ? { ...m, childrenCount: m.childrenCount + 1 }
		  : m
	  ),
	  { role: "user", content: userText, nodeId: userNode.id, childrenCount: 0, deletedChildrenCount: 0 },
	];
	setMessages(updatedMessages);

    try {
      const llmMessages: LlmMessage[] = updatedMessages.map(m => ({ role: m.role, content: m.content }));
      const response = await invoke<string>("send_message", { messages: llmMessages, modelId: MODEL });

      const assistantNode = await invoke<DbNode>("cmd_create_node", {
        dialogId: dId,
        parentId: userNode.id,
        nodeType: "assistant_message",
        content: response,
        modelId: MODEL,
        modelRole: "main_dialog",
        tokensCount: 0,
      });

      setMessages([
        ...updatedMessages,
        { role: "assistant", content: response, nodeId: assistantNode.id, childrenCount: 0, deletedChildrenCount: 0 },
      ]);
      setLastNodeId(assistantNode.id);

      const indicators = await invoke<DepthIndicators>("cmd_get_depth_indicators", { dialogId: dId });
      setDepth(indicators);
    } catch (e) {
      setMessages([
        ...updatedMessages,
        { role: "assistant", content: `Error: ${e}`, nodeId: "", childrenCount: 0, deletedChildrenCount: 0 },
      ]);
      setLastNodeId(userNode.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Рендер
  // ---------------------------------------------------------------------------

  if (hasApiKey === null) {
    return <main className="container"><p className="loading">Loading...</p></main>;
  }

  if (hasApiKey === false) {
    return (
      <main className="container">
        <h1>AiZavr</h1>
        <div className="setup">
          <p>Enter your <a href="https://openrouter.ai/keys" target="_blank">OpenRouter API key</a> to get started.</p>
          <div className="input-row">
            <input
              type="password"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && saveApiKey()}
              placeholder="sk-or-..."
            />
            <button onClick={saveApiKey}>Save</button>
          </div>
          {keyError && <p className="error">{keyError}</p>}
        </div>
      </main>
    );
  }

  const isBlocked = forkMode || deletedMode;

  return (
    <main className="container">
      <h1>AiZavr</h1>

      {/* Индикаторы глубины */}
      <div className="depth-indicators">
        <div className="depth-left">
          {Array.from({ length: depth.depth_left }).map((_, i) => (
            <span key={i} className="depth-bar" />
          ))}
        </div>
        <div className="depth-right">
          {Array.from({ length: depth.branches_right }).map((_, i) => (
            <span key={i} className="depth-bar" />
          ))}
        </div>
      </div>

      {/* Режим развилки */}
      {forkMode && (
        <div className="fork-overlay">
          <div className="fork-header">
            <span className="fork-title">Выбор ветки</span>
            <button className="fork-close-btn" onClick={closeForkMode}>✕</button>
          </div>
          <div className="fork-cards" ref={cardsRef}>
            {forkCards.map((card, idx) => (
              <div
                key={card.nodeId}
                className={`fork-card ${idx === forkActiveIdx ? "fork-card--active" : ""} ${card.isActive ? "fork-card--current" : ""}`}
                onMouseEnter={() => setForkActiveIdx(idx)}
                onClick={() => { if (editingNodeId !== card.nodeId) handleCardClick(idx); }}
                onDoubleClick={() => handleCardDoubleClick(card.nodeId)}
              >
                {editingNodeId === card.nodeId ? (
                  <input
                    className="fork-card-edit"
                    autoFocus
                    value={editingText}
                    onChange={e => setEditingText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") { e.preventDefault(); saveEditing(); }
                      else if (e.key === "Escape") { e.preventDefault(); cancelEditing(); }
                    }}
                    onBlur={saveEditing}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="fork-card-name">{card.branchName}</span>
                    {card.isActive && <span className="fork-card-badge">текущая</span>}

                    <button
                      className="fork-card-menu-btn"
                      title="Меню ветки"
                      onClick={e => {
                        e.stopPropagation();
                        setMenuNodeId(menuNodeId === card.nodeId ? null : card.nodeId);
                      }}
                    >
                      ⋮
                    </button>

                    {menuNodeId === card.nodeId && (
                      <div className="fork-card-menu" onClick={e => e.stopPropagation()}>
                        <button onClick={() => startEditing(card.nodeId)}>Редактировать</button>
                        <button
                          onClick={() => deleteCardBranch(card.nodeId)}
                          style={{ color: "#c0392b" }}
                        >
                          Удалить ветку
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="fork-hint">Ctrl+← → или мышь · Enter / Ctrl+↓ / клик — перейти · F2 / двойной клик — переименовать</div>
        </div>
      )}

      {/* Режим восстановления удалённых веток (D-050) */}
      {deletedMode && (
        <div className="deleted-overlay">
          <div className="fork-header">
            <span className="deleted-title">Удалённые ветки</span>
            <button className="fork-close-btn" onClick={closeDeletedMode}>✕</button>
          </div>
          <div className="fork-cards">
            {deletedForkCards.map(card => (
              <div key={card.nodeId} className="deleted-card">
                <span className="deleted-card-name">{card.branchName}</span>
                <button
                  className="restore-btn"
                  onClick={() => restoreBranch(card.nodeId)}
                >
                  Восстановить
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Сообщения */}
      <div className="messages" ref={messagesRef}>
        {messages.map((m, i) => {
          const visibleCount = m.childrenCount - m.deletedChildrenCount;
          return (
            <div
              key={i}
              className={`message ${m.role}`}
              ref={el => { messageEls.current[i] = el; }}
            >
              <div className="message-content">
                <p>{m.content}</p>
              </div>

              {m.role === "assistant" && (
				<div className="message-actions">
					{visibleCount > 1 && (
					  <button
						className="fork-btn"
						title={`Развилка (${visibleCount} ветки)`}
						onClick={() => openForkMode(m.nodeId)}
					  >
						⑂
					  </button>
					)}

					{m.deletedChildrenCount > 0 && (
					  <button
						className="fork-btn--deleted"
						title={`Удалённые ветки: ${m.deletedChildrenCount}`}
						onClick={() => openDeletedMode(m.nodeId)}
					  >
						⑂{m.deletedChildrenCount > 1 ? ` ×${m.deletedChildrenCount}` : ""}
					  </button>
					)}

					{m.childrenCount > 0 && (
					  <button
						className="branch-btn"
						title="Создать ветку"
						onClick={() => {
						  setBranchingFromId(branchingFromId === m.nodeId ? null : m.nodeId);
						  setBranchInput("");
						}}
					  >
						+
					  </button>
					)}
				  </div>
				)}

              {branchingFromId === m.nodeId && (
                <div className="branch-input-row">
                  <input
                    autoFocus
                    value={branchInput}
                    onChange={e => setBranchInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && sendBranch()}
                    placeholder="Альтернативный вопрос..."
                    disabled={loading}
                  />
                  <button onClick={sendBranch} disabled={loading}>→</button>
                  <button onClick={() => setBranchingFromId(null)}>✕</button>
                </div>
              )}
            </div>
          );
        })}
        {loading && <p className="loading">Думаю...</p>}
      </div>

      {/* Поле ввода */}
      <div className="input-row">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && sendMessage()}
          placeholder="Введите сообщение..."
          disabled={loading || !dialogId || isBlocked}
        />
        <button onClick={sendMessage} disabled={loading || !dialogId || isBlocked}>
          Отправить
        </button>
      </div>
    </main>
  );
}

export default App;