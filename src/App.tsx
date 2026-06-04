import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface Message {
  role: "user" | "assistant";
  content: string;
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
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [dialogId, setDialogId] = useState<string | null>(null);
  const [lastNodeId, setLastNodeId] = useState<string | null>(null);

  // null — ещё не знаем, false — нет ключа, true — ключ есть
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState("");

  const MODEL = "anthropic/claude-haiku-4-5";

  // При старте: проверяем ключ, потом инициализируем диалог
  useEffect(() => {
    async function init() {
      const key = await invoke<string | null>("cmd_get_api_key", {
        providerId: "openrouter",
      });

      if (!key) {
        setHasApiKey(false);
        return;
      }

      setHasApiKey(true);
      await initDialog();
    }

    init().catch(console.error);
  }, []);

  async function initDialog() {
    const dialogs = await invoke<DbDialog[]>("cmd_list_dialogs");

    if (dialogs.length > 0) {
      const d = dialogs[0];
      setDialogId(d.id);

      const branch = await invoke<DbNode[]>("cmd_get_branch", {
        dialogId: d.id,
      });

      const restored: Message[] = branch
        .filter((n) => n.node_type === "user_message" || n.node_type === "assistant_message")
        .map((n) => ({
          role: n.node_type === "user_message" ? "user" : "assistant",
          content: n.content,
        }));

      setMessages(restored);

      if (branch.length > 0) {
        setLastNodeId(branch[branch.length - 1].id);
      }
    } else {
      const d = await invoke<DbDialog>("cmd_create_dialog", {
        title: "New conversation",
        notebookId: null,
      });
      setDialogId(d.id);
    }
  }

  async function saveApiKey() {
    setKeyError("");
    const trimmed = keyInput.trim();

    if (!trimmed) {
      setKeyError("Key cannot be empty.");
      return;
    }

    try {
      await invoke("cmd_set_api_key", {
        providerId: "openrouter",
        apiKey: trimmed,
      });
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

    const userNode = await invoke<DbNode>("cmd_create_node", {
      dialogId,
      parentId: lastNodeId,
      nodeType: "user_message",
      content: userText,
      modelId: null,
      modelRole: null,
      tokensCount: 0,
    });

    const updatedMessages: Message[] = [...messages, { role: "user", content: userText }];
    setMessages(updatedMessages);

    try {
      const llmMessages = updatedMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await invoke<string>("send_message", {
        messages: llmMessages,
        modelId: MODEL,
      });

      const assistantNode = await invoke<DbNode>("cmd_create_node", {
        dialogId,
        parentId: userNode.id,
        nodeType: "assistant_message",
        content: response,
        modelId: MODEL,
        modelRole: "main_dialog",
        tokensCount: 0,
      });

      setMessages([...updatedMessages, { role: "assistant", content: response }]);
      setLastNodeId(assistantNode.id);
    } catch (e) {
      setMessages([...updatedMessages, { role: "assistant", content: `Error: ${e}` }]);
      setLastNodeId(userNode.id);
    } finally {
      setLoading(false);
    }
  }

  // Экран загрузки
  if (hasApiKey === null) {
    return <main className="container"><p>Loading...</p></main>;
  }

  // Экран ввода ключа
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
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveApiKey()}
              placeholder="sk-or-..."
            />
            <button onClick={saveApiKey}>Save</button>
          </div>
          {keyError && <p className="error">{keyError}</p>}
        </div>
      </main>
    );
  }

  // Основной экран
  return (
    <main className="container">
      <h1>AiZavr</h1>

      <div className="messages">
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            <span className="role">{m.role === "user" ? "You" : "AI"}</span>
            <p>{m.content}</p>
          </div>
        ))}
        {loading && <p className="loading">Thinking...</p>}
      </div>

      <div className="input-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder="Type a message..."
          disabled={loading || !dialogId}
        />
        <button onClick={sendMessage} disabled={loading || !dialogId}>
          Send
        </button>
      </div>
    </main>
  );
}

export default App;