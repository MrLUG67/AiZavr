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
  childrenCount: number; // children_count A-узла
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
}

interface DepthIndicators {
  depth_left: number;
  branches_right: number;
}

interface BranchResult {
  new_node_id: string;
  dialog_id: string;
}

// Карточка в режиме развилки
interface BranchCard {
  nodeId: string;       // id Q-узла
  branchName: string;   // branch_name ?? первые 80 символов контента
  isActive: boolean;    // это активная ветка?
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
  const [forkNodeId, setForkNodeId] = useState<string | null>(null); // id A-узла развилки
  const [forkCards, setForkCards] = useState<BranchCard[]>([]);
  const [forkActiveIdx, setForkActiveIdx] = useState(0);
  const cardsRef = useRef<HTMLDivElement>(null);

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

  // Клавиатурная навигация
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Enter в режиме развилки — выбор активной карточки (без Ctrl)
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
  }, [forkMode, forkCards, forkActiveIdx, messages, dialogId]);

  // Скролл карточек колесом мыши
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

    const restored: Message[] = branch
      .filter(n => n.node_type === "user_message" || n.node_type === "assistant_message")
      .map(n => ({
        role: n.node_type === "user_message" ? "user" : "assistant",
        content: n.content,
        nodeId: n.id,
        childrenCount: n.children_count,
      }));

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
    setForkMode(false);
    setForkNodeId(null);
    setForkCards([]);
  }

  // Выбрать ветку в режиме развилки — атомарно на backend.
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

  // Ctrl+Up — найти ближайший A-узел с children_count > 1 вверх по ветке
  function handleCtrlUp() {
    if (forkMode) return;
    // Идём по messages снизу вверх, ищем assistant с childrenCount > 1
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.childrenCount > 1) {
        openForkMode(m.nodeId);
        return;
      }
    }
  }

  // Ctrl+Down — «провалиться» в выбранную ветку (D-045): подтвердить выбор.
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
      ...messages,
      { role: "user", content: userText, nodeId: userNode.id, childrenCount: 0 },
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
        { role: "assistant", content: response, nodeId: assistantNode.id, childrenCount: 0 },
      ]);
      setLastNodeId(assistantNode.id);

      const indicators = await invoke<DepthIndicators>("cmd_get_depth_indicators", { dialogId: dId });
      setDepth(indicators);
    } catch (e) {
      setMessages([
        ...updatedMessages,
        { role: "assistant", content: `Error: ${e}`, nodeId: "", childrenCount: 0 },
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
                onClick={() => selectForkCard(idx)}
                onMouseEnter={() => setForkActiveIdx(idx)}
              >
                <span className="fork-card-name">{card.branchName}</span>
                {card.isActive && <span className="fork-card-badge">текущая</span>}
              </div>
            ))}
          </div>
          <div className="fork-hint">Ctrl+← → или мышь — выбор · Enter / Ctrl+↓ / клик — перейти · ✕ — отмена</div>
        </div>
      )}

      {/* Сообщения */}
      <div className="messages">
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            <div className="message-content">
              <p>{m.content}</p>
            </div>

            {/* Панель действий — только для A-узлов */}
            {m.role === "assistant" && (
              <div className="message-actions">
                {/* Иконка дерева — только если есть ветки */}
                {m.childrenCount > 1 && (
                  <button
                    className="fork-btn"
                    title={`Развилка (${m.childrenCount} ветки)`}
                    onClick={() => openForkMode(m.nodeId)}
                  >
                    ⑂
                  </button>
                )}
                {/* Кнопка новой ветки */}
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
              </div>
            )}

            {/* Поле ввода альтернативного вопроса */}
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
        ))}
        {loading && <p className="loading">Думаю...</p>}
      </div>

      {/* Поле ввода */}
      <div className="input-row">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && sendMessage()}
          placeholder="Введите сообщение..."
          disabled={loading || !dialogId || forkMode}
        />
        <button onClick={sendMessage} disabled={loading || !dialogId || forkMode}>
          Отправить
        </button>
      </div>
    </main>
  );
}

export default App;
