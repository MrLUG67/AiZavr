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
    model: String,
    usage: Usage,
}

#[derive(Deserialize)]
struct Choice {
    message: ChatMessageResponse,
}

#[derive(Deserialize)]
struct ChatMessageResponse {
    content: String,
}

#[derive(Deserialize)]
struct Usage {
    prompt_tokens: u32,
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

        let response = self
            .client
            .post("https://openrouter.ai/api/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json::<ChatResponse>()
            .await
            .map_err(|e| e.to_string())?;

        Ok(LlmResponse {
            content: response.choices[0].message.content.clone(),
            model_id: response.model,
            tokens_input: response.usage.prompt_tokens,
            tokens_output: response.usage.completion_tokens,
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