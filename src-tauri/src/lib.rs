use tauri::Manager;

mod db;
mod tree;
mod keychain;
mod markers;
mod compression;
mod notebooks;

use db::{DbDialog, DbNode};
use notebooks::DbNotebook;

struct AppState {
    db: sqlx::SqlitePool,
}

// ---------------------------------------------------------------------------
// Диалоги
// ---------------------------------------------------------------------------

#[tauri::command]
async fn cmd_create_dialog(
    state: tauri::State<'_, AppState>,
    title: String,
    notebook_id: Option<String>,
    root_marker_comment: String,
) -> Result<DbDialog, String> {
    let id = uuid::Uuid::new_v4().to_string();
    db::create_dialog(&state.db, &id, &title, notebook_id.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    // Засев синтетического корневого анкора Q0->A0 + маркер #0 (D-090).
    tree::seed_root_anchor(&state.db, &id, &root_marker_comment).await?;
    db::get_dialog(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "dialog not found after create".to_string())
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

#[tauri::command]
async fn cmd_get_dialog_tags(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
) -> Result<Vec<String>, String> {
    db::get_dialog_tags(&state.db, &dialog_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_set_dialog_tags(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
    tags: Vec<String>,
) -> Result<Vec<String>, String> {
    db::set_dialog_tags(&state.db, &dialog_id, &tags).await
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

/// Удалённые дети узла — для индикатора ⑂ в подвале A-узла (D-050).
#[tauri::command]
async fn cmd_get_deleted_children(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<Vec<DbNode>, String> {
    db::get_deleted_children(&state.db, &node_id)
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

/// Мягкое удаление ветки (D-048, D-049).
/// fork_node_id — A-узел развилки, child_id — удаляемый Q-узел.
#[tauri::command]
async fn cmd_delete_branch(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
    fork_node_id: String,
    child_id: String,
) -> Result<(), String> {
    tree::delete_branch_atomic(&state.db, &dialog_id, &fork_node_id, &child_id).await
}

/// Восстановление удалённой ветки (D-050).
#[tauri::command]
async fn cmd_restore_branch(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<(), String> {
    tree::restore_branch_atomic(&state.db, &node_id).await
}

#[tauri::command]
async fn cmd_get_depth_indicators(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
) -> Result<tree::DepthIndicators, String> {
    tree::get_depth_indicators(&state.db, &dialog_id).await
}

/// Отправка пользовательского сообщения (устойчивый поток).
/// Создаёт Q + unanswered_placeholder атомарно. Реальный ответ затем
/// приходит через cmd_resolve_answer(placeholder_id, ...).
#[tauri::command]
async fn cmd_send_user_message(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
    parent_id: Option<String>,
    content: String,
) -> Result<db::SendResult, String> {
    db::send_user_message(&state.db, &dialog_id, parent_id.as_deref(), &content)
        .await
        .map_err(|e| e.to_string())
}

/// Перезаписать заглушку реальным ответом LLM
/// (unanswered_placeholder → assistant_message).
#[tauri::command]
async fn cmd_resolve_answer(
    state: tauri::State<'_, AppState>,
    placeholder_id: String,
    content: String,
    model_id: Option<String>,
    model_role: Option<String>,
    tokens_count: i64,
) -> Result<DbNode, String> {
    db::resolve_answer(
        &state.db,
        &placeholder_id,
        &content,
        model_id.as_deref(),
        model_role.as_deref(),
        tokens_count,
    )
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Маркеры (D-058) — CRUD
// ---------------------------------------------------------------------------

#[tauri::command]
async fn cmd_create_marker(
    state: tauri::State<'_, AppState>,
    node_id: String,
    label: String,
    comment: Option<String>,
) -> Result<markers::Marker, String> {
    markers::create_marker(&state.db, &node_id, &label, comment.as_deref()).await
}

#[tauri::command]
async fn cmd_get_markers_for_node(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<Vec<markers::Marker>, String> {
    markers::get_markers_for_node(&state.db, &node_id).await
}

#[tauri::command]
async fn cmd_list_markers_for_dialog(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
) -> Result<Vec<markers::Marker>, String> {
    markers::list_markers_for_dialog(&state.db, &dialog_id).await
}

#[tauri::command]
async fn cmd_update_marker(
    state: tauri::State<'_, AppState>,
    marker_id: String,
    label: String,
    comment: Option<String>,
) -> Result<(), String> {
    markers::update_marker(&state.db, &marker_id, &label, comment.as_deref()).await
}

/// Удалить маркер. Запрещено при наличии ссылки от сжатия (D-067).
#[tauri::command]
async fn cmd_delete_marker(
    state: tauri::State<'_, AppState>,
    marker_id: String,
) -> Result<(), String> {
    markers::delete_marker(&state.db, &marker_id).await
}

/// Заблокирован ли узел маркера ссылкой от сжатия (D-067).
/// true ⟺ удаление маркера на этом узле запрещено. Для UX «кнопка задизейблена
/// + тултип» (как D-049), чтобы не получать ошибку постфактум. В MVP всегда
/// false (S-узлов ещё нет) — но хук правильный.
#[tauri::command]
async fn cmd_is_node_referenced_by_compression(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<bool, String> {
    markers::is_node_referenced_by_compression(&state.db, &node_id).await
}

// ---------------------------------------------------------------------------
// Маркеры — топология (D-066)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn cmd_list_startable_markers(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
) -> Result<Vec<markers::Marker>, String> {
    markers::list_startable_markers(&state.db, &dialog_id).await
}

#[tauri::command]
async fn cmd_list_reachable_ends(
    state: tauri::State<'_, AppState>,
    from_node_id: String,
) -> Result<Vec<markers::ReachableEnd>, String> {
    markers::list_reachable_ends(&state.db, &from_node_id).await
}

/// Линеаризовать диапазон start..end (D-066). Инклюзивный путь, start первым.
#[tauri::command]
async fn cmd_resolve_linear_range(
    state: tauri::State<'_, AppState>,
    start_node_id: String,
    end_node_id: String,
) -> Result<Vec<DbNode>, String> {
    markers::resolve_linear_range(&state.db, &start_node_id, &end_node_id).await
}

// ---------------------------------------------------------------------------
// Сжатие (D-060/D-061/D-065/D-088)
// ---------------------------------------------------------------------------

/// Прикрепить готовый результат сжатия диапазона start..end в дерево.
/// ЯДРО только крепит (S + заглушка + extra + провенанс модели); сам текст
/// резюме формирует ПЛАГИН (D-066). model_id = модель-уплотнитель (None для
/// детерминированного компрессора-заглушки), model_role проставляется ядром.
#[tauri::command]
async fn cmd_attach_compressed(
    state: tauri::State<'_, AppState>,
    start_node_id: String,
    end_node_id: String,
    summary_text: String,
    placeholder_text: Option<String>,
    model_id: Option<String>,
    provenance: compression::CompressionProvenance,
) -> Result<compression::AttachResult, String> {
    compression::attach_compressed(
        &state.db,
        &start_node_id,
        &end_node_id,
        &summary_text,
        placeholder_text.as_deref(),
        model_id.as_deref(),
        provenance,
    )
    .await
}

/// Прочитать метрику происхождения сжатия с узла S (D-065).
#[tauri::command]
async fn cmd_get_compression_meta(
    state: tauri::State<'_, AppState>,
    summary_node_id: String,
) -> Result<Option<serde_json::Value>, String> {
    compression::get_compression_meta(&state.db, &summary_node_id).await
}

// ---------------------------------------------------------------------------
// Блокноты (сессия 11) — организация бесед
// ---------------------------------------------------------------------------

#[tauri::command]
async fn cmd_list_notebooks(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<DbNotebook>, String> {
    notebooks::list_notebooks(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_create_notebook(
    state: tauri::State<'_, AppState>,
    parent_id: String,
    name: String,
) -> Result<DbNotebook, String> {
    notebooks::create_notebook(&state.db, &parent_id, &name).await
}

#[tauri::command]
async fn cmd_rename_notebook(
    state: tauri::State<'_, AppState>,
    notebook_id: String,
    name: String,
) -> Result<(), String> {
    notebooks::rename_notebook(&state.db, &notebook_id, &name).await
}

/// Переподчинить блокнот (reparent) с проверкой цикла/глубины/ветвления.
#[tauri::command]
async fn cmd_move_notebook(
    state: tauri::State<'_, AppState>,
    notebook_id: String,
    new_parent_id: String,
) -> Result<(), String> {
    notebooks::move_notebook(&state.db, &notebook_id, &new_parent_id).await
}

/// Удалить блокнот = мягкий перенос в корзину (со всем поддеревом и беседами).
#[tauri::command]
async fn cmd_delete_notebook(
    state: tauri::State<'_, AppState>,
    notebook_id: String,
) -> Result<(), String> {
    notebooks::delete_notebook(&state.db, &notebook_id).await
}

#[tauri::command]
async fn cmd_list_dialogs_in_notebook(
    state: tauri::State<'_, AppState>,
    notebook_id: String,
) -> Result<Vec<DbDialog>, String> {
    notebooks::list_dialogs_in_notebook(&state.db, &notebook_id)
        .await
        .map_err(|e| e.to_string())
}

/// Создать беседу в блокноте (нельзя в корне/корзине; лимит 1024).
#[tauri::command]
async fn cmd_create_dialog_in_notebook(
    state: tauri::State<'_, AppState>,
    notebook_id: String,
    title: String,
    root_marker_comment: String,
) -> Result<DbDialog, String> {
    let dialog = notebooks::create_dialog_in_notebook(&state.db, &notebook_id, &title).await?;
    // Засев синтетического корневого анкора Q0->A0 + маркер #0 (D-090).
    tree::seed_root_anchor(&state.db, &dialog.id, &root_marker_comment).await?;
    db::get_dialog(&state.db, &dialog.id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "dialog not found after create".to_string())
}

/// Переподчинить беседу в другой блокнот.
#[tauri::command]
async fn cmd_move_dialog(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
    new_notebook_id: String,
) -> Result<(), String> {
    notebooks::move_dialog(&state.db, &dialog_id, &new_notebook_id).await
}

/// Удалить беседу = мягкий перенос в корзину.
#[tauri::command]
async fn cmd_delete_dialog(
    state: tauri::State<'_, AppState>,
    dialog_id: String,
) -> Result<(), String> {
    notebooks::delete_dialog(&state.db, &dialog_id).await
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
            cmd_create_dialog,
            cmd_get_dialog,
            cmd_list_dialogs,
            cmd_update_dialog_title,
            cmd_update_dialog_leaf,
            cmd_get_dialog_tags,
            cmd_set_dialog_tags,
            cmd_create_node,
            cmd_get_node,
            cmd_get_branch,
            cmd_get_children,
            cmd_get_deleted_children,
            cmd_set_active_child,
            cmd_set_branch_name,
            cmd_set_last_visited_leaf,
            cmd_branch_from_node,
            cmd_select_branch,
            cmd_delete_branch,
            cmd_restore_branch,
            cmd_get_depth_indicators,
            cmd_send_user_message,
            cmd_resolve_answer,
            cmd_create_marker,
            cmd_get_markers_for_node,
            cmd_list_markers_for_dialog,
            cmd_update_marker,
            cmd_delete_marker,
            cmd_is_node_referenced_by_compression,
            cmd_list_startable_markers,
            cmd_list_reachable_ends,
            cmd_resolve_linear_range,
            cmd_attach_compressed,
            cmd_get_compression_meta,
            cmd_list_notebooks,
            cmd_create_notebook,
            cmd_rename_notebook,
            cmd_move_notebook,
            cmd_delete_notebook,
            cmd_list_dialogs_in_notebook,
            cmd_create_dialog_in_notebook,
            cmd_move_dialog,
            cmd_delete_dialog,
            cmd_set_api_key,
            cmd_get_api_key,
            cmd_delete_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AiZavr");
}