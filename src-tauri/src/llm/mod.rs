use serde::{Deserialize, Serialize};

pub mod openrouter;

// A single message in a conversation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,    // "user" | "assistant" | "system"
    pub content: String,
}

// Response from LLM
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmResponse {
    pub content: String,
    pub model_id: String,
    pub tokens_input: u32,
    pub tokens_output: u32,
}

// The provider trait — every LLM provider implements this
#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    async fn send(&self, messages: Vec<Message>, model_id: &str) -> Result<LlmResponse, String>;
    async fn list_models(&self) -> Result<Vec<String>, String>;
}