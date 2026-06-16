use super::{LlmProvider, LlmResponse, Message};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};

pub struct OpenRouterProvider {
    api_key: String,
    client: Client,
}

impl OpenRouterProvider {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            client: Client::new(),
        }
    }
}

// OpenRouter request/response shapes
#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
}

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
    // model и usage НЕ гарантированы в каждом ответе — делаем опциональными,
    // иначе их отсутствие валит весь парсинг ("error decoding response body").
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChatMessageResponse,
}

#[derive(Deserialize)]
struct ChatMessageResponse {
    // content тоже опционален: на ошибках/некоторых ответах поля может не быть.
    #[serde(default)]
    content: Option<String>,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
}

#[async_trait]
impl LlmProvider for OpenRouterProvider {
    async fn send(&self, messages: Vec<Message>, model_id: &str) -> Result<LlmResponse, String> {
        let request = ChatRequest {
            model: model_id.to_string(),
            messages: messages
                .into_iter()
                .map(|m| ChatMessage {
                    role: m.role,
                    content: m.content,
                })
                .collect(),
        };

        let resp = self
            .client
            .post("https://openrouter.ai/api/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            // OpenRouter рекомендует эти заголовки; без них некоторые модели
            // отвечают ошибкой. Можно заменить на свой домен/имя приложения.
            .header("HTTP-Referer", "https://github.com/MrLUG67/AiZavr")
            .header("X-Title", "AiZavr")
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;

        let status = resp.status();

        // Читаем тело КАК ТЕКСТ, не сразу в структуру. Так при любой проблеме
        // видно реальный ответ OpenRouter (например {"error":{"message":...}}),
        // а не слепое "error decoding response body".
        let body = resp
            .text()
            .await
            .map_err(|e| format!("failed to read response body: {e}"))?;

        if !status.is_success() {
            return Err(format!("OpenRouter HTTP {status}: {body}"));
        }

        let parsed: ChatResponse = serde_json::from_str(&body).map_err(|e| {
            // Тело пришло, но не распарсилось — отдаём и причину, и сам ответ.
            format!("failed to parse OpenRouter response: {e}. Body: {body}")
        })?;

        let content = parsed
            .choices
            .get(0)
            .and_then(|c| c.message.content.clone())
            .ok_or_else(|| format!("OpenRouter response has no content. Body: {body}"))?;

        let usage = parsed.usage.unwrap_or(Usage {
            prompt_tokens: 0,
            completion_tokens: 0,
        });

        Ok(LlmResponse {
            content,
            model_id: parsed.model.unwrap_or_else(|| model_id.to_string()),
            tokens_input: usage.prompt_tokens,
            tokens_output: usage.completion_tokens,
        })
    }

    async fn list_models(&self) -> Result<Vec<String>, String> {
        // TODO: fetch from https://openrouter.ai/api/v1/models
        Ok(vec![
            "anthropic/claude-sonnet-4-5".to_string(),
            "openai/gpt-4o".to_string(),
            "google/gemini-pro".to_string(),
        ])
    }
}