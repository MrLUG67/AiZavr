use tauri::Manager;

mod db;
mod llm;
mod tree;
mod keychain;

use db::{DbDialog, DbNode};
use llm::{Message, openrouter::OpenRouterProvider, LlmProvider};

struct AppState {
    db: sqlx::SqlitePool,
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

#[tauri::command]
async fn send_message(
    messages: Vec<Message>,
    model_id: String,
) -> Result<String, String> {
    let api_key = keychain::get_api_key("openrouter")?
        .ok_or_else(|| "OpenRouter API key not set. Use Settings to add it.".to_string())?;

    let provider = OpenRouterProvider::new(api_key);
    let response = provider.send(messages, &model_id).await?;
    Ok(response.content)
}

// ---------------------------------------------------------------------------
// Диалоги
// ---------------------------------------------------------------------------

#[tauri::command]
async fn cmd_create_dialog(
    state: tauri::State<'_, AppState>,
    title: String,
    notebook_id: Option<String>,
) -> Result<DbDialog, String> {
    let id = uuid::Uuid::new_v4().to_string();
    db::create_dialog(&state.db, &id, &title, notebook_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_get_dialog(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
) -> Result<Option<DbDialog>, String> {
    db::get_dialog(&state.db, &dialog_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_list_dialogs(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<DbDialog>, String> {
    db::list_dialogs(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_update_dialog_title(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
    title: String,
) -> Result<(), String> {
    db::update_dialog_title(&state.db, &dialog_id, &title)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_update_dialog_leaf(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
    leaf_id: String,
) -> Result<(), String> {
    db::update_dialog_leaf(&state.db, &dialog_id, &leaf_id)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Узлы
// ---------------------------------------------------------------------------

#[tauri::command]
async fn cmd_create_node(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
    parent_id: Option<String>,
    node_type: String,
    content: String,
    model_id: Option<String>,
    model_role: Option<String>,
    tokens_count: i64,
) -> Result<DbNode, String> {
    let id = uuid::Uuid::new_v4().to_string();
    db::create_node(
        &state.db,
        &id,
        &dialog_id,
        parent_id.as_deref(),
        &node_type,
        &content,
        model_id.as_deref(),
        model_role.as_deref(),
        tokens_count,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_get_node(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<Option<DbNode>, String> {
    db::get_node(&state.db, &node_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_get_branch(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
) -> Result<Vec<DbNode>, String> {
    db::get_branch(&state.db, &dialog_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_get_children(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<Vec<DbNode>, String> {
    db::get_children(&state.db, &node_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_set_active_child(
    state: tauri::State<'_, AppState>,
    node_id: String,
    child_id: String,
) -> Result<(), String> {
    db::set_active_child(&state.db, &node_id, &child_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_set_branch_name(
    state: tauri::State<'_, AppState>,
    node_id: String,
    name: String,
) -> Result<(), String> {
    db::set_branch_name(&state.db, &node_id, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_set_last_visited_leaf(
    state: tauri::State<'_, AppState>,
    node_id: String,
    leaf_id: String,
) -> Result<(), String> {
    db::set_last_visited_leaf(&state.db, &node_id, &leaf_id)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Дерево
// ---------------------------------------------------------------------------

#[tauri::command]
async fn cmd_branch_from_node(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
    parent_id: String,
    content: String,
) -> Result<tree::BranchResult, String> {
    tree::branch_from_node(&state.db, &dialog_id, &parent_id, &content).await
}

#[tauri::command]
async fn cmd_select_branch(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
    fork_node_id: String,
    child_id: String,
) -> Result<(), String> {
    tree::select_branch(&state.db, &dialog_id, &fork_node_id, &child_id).await
}

#[tauri::command]
async fn cmd_get_depth_indicators(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
) -> Result<tree::DepthIndicators, String> {
    tree::get_depth_indicators(&state.db, &dialog_id).await
}

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

#[tauri::command]
fn cmd_set_api_key(provider_id: String, api_key: String) -> Result<(), String> {
    keychain::set_api_key(&provider_id, &api_key)
}

#[tauri::command]
fn cmd_get_api_key(provider_id: String) -> Result<Option<String>, String> {
    keychain::get_api_key(&provider_id)
}

#[tauri::command]
fn cmd_delete_api_key(provider_id: String) -> Result<(), String> {
    keychain::delete_api_key(&provider_id)
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

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

            let pool = tauri::async_runtime::block_on(async {
                db::init_db(&app_data_dir)
                    .await
                    .expect("failed to initialize database")
            });

            app.manage(AppState { db: pool });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_message,
            cmd_create_dialog,
            cmd_get_dialog,
            cmd_list_dialogs,
            cmd_update_dialog_title,
            cmd_update_dialog_leaf,
            cmd_create_node,
            cmd_get_node,
            cmd_get_branch,
            cmd_get_children,
            cmd_set_active_child,
            cmd_set_branch_name,
            cmd_set_last_visited_leaf,
            cmd_set_api_key,
            cmd_get_api_key,
            cmd_delete_api_key,
            cmd_branch_from_node,
            cmd_select_branch,
            cmd_get_depth_indicators,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AiZavr");
}
