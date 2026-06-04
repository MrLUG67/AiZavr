import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface Message {
  role: "user" | "assistant";
  content: string;
}

// Соответствует DbDialog из Rust
interface DbDialog {
  id: string;
  title: string;
  root_node_id: string | null;
  active_leaf_id: string | null;
}

// Соответствует DbNode из Rust
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
  // id последнего узла — parent для следующего
  const [lastNodeId, setLastNodeId] = useState<string | null>(null);

  const API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY ?? "";
  const MODEL = "anthropic/claude-haiku-4-5";

  // При старте: загружаем последний диалог или создаём новый
  useEffect(() => {
    async function initDialog() {
      const dialogs = await invoke<DbDialog[]>("cmd_list_dialogs");

      if (dialogs.length > 0) {
        const d = dialogs[0]; // последний по updated_at
        setDialogId(d.id);

        // Загружаем ветку из БД и восстанавливаем messages
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

        // Запоминаем id последнего узла как точку продолжения
        if (branch.length > 0) {
          setLastNodeId(branch[branch.length - 1].id);
        }
      } else {
        // Первый запуск — создаём диалог
        const d = await invoke<DbDialog>("cmd_create_dialog", {
          title: "New conversation",
          notebookId: null,
        });
        setDialogId(d.id);
      }
    }

    initDialog().catch(console.error);
  }, []);

  async function sendMessage() {
    if (!input.trim() || loading || !dialogId) return;

    const userText = input.trim();
    setInput("");
    setLoading(true);

    // 1. Сохраняем узел пользователя в БД
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
      // 2. Отправляем в LLM
      const llmMessages = updatedMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await invoke<string>("send_message", {
        messages: llmMessages,
        modelId: MODEL,
        apiKey: API_KEY,
      });

      // 3. Сохраняем ответ модели в БД
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
      // Ошибка — откатываем UI, узел пользователя уже в БД, это нормально
      setMessages([...updatedMessages, { role: "assistant", content: `Error: ${e}` }]);
      setLastNodeId(userNode.id);
    } finally {
      setLoading(false);
    }
  }

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