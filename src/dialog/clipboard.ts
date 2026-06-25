// src/dialog/clipboard.ts
// Копирование текста в системный буфер обмена. Чистая UI-утилита (ядро/БД не
// нужны). Основной путь — асинхронный navigator.clipboard (в WebView2 Tauri
// работает в защищённом контексте, отдельных Tauri-разрешений не требует).
// Запасной путь — скрытая textarea + execCommand('copy') для сред, где
// async-clipboard недоступен или заблокирован.

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // тихо падаем в запасной путь ниже
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
