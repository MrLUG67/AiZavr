use tauri::Manager;

mod db;
mod llm;
mod tree;
mod keychain;

use llm::{Message, openrouter::OpenRouterProvider, LlmProvider};

#[tauri::command]
async fn send_message(
    messages: Vec<Message>,
    model_id: String,
    api_key: String,
) -> Result<String, String> {
    let provider = OpenRouterProvider::new(api_key);
    let response = provider.send(messages, &model_id).await?;
    Ok(response.content)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to get app data dir")
                .to_string_lossy()
                .to_string();

            tauri::async_runtime::spawn(async move {
                db::init_db(&app_data_dir)
                    .await
                    .expect("failed to initialize database");
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send_message])
        .run(tauri::generate_context!())
        .expect("error while running AiZavr");
}