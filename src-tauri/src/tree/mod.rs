// src-tauri/src/tree/mod.rs

use crate::db;
use sqlx::SqlitePool;

/// Результат операции ветвления — возвращается в UI.
#[derive(Debug, serde::Serialize)]
pub struct BranchResult {
    pub new_node_id: String,
    pub dialog_id: String,
}

/// Создать новую ветку от указанного родительского узла.
/// parent_id — A-узел от которого ветвимся.
/// Новый Q-узел становится активным потомком родителя.
pub async fn branch_from_node(
    pool: &SqlitePool,
    dialog_id: &str,
    parent_id: &str,
    content: &str,
) -> Result<BranchResult, String> {
    let id = uuid::Uuid::new_v4().to_string();

    db::create_node(
        pool,
        &id,
        dialog_id,
        Some(parent_id),
        "user_message",
        content,
        None,
        None,
        0,
    )
    .await
    .map_err(|e| e.to_string())?;

    // create_node уже прописал active_child у родителя, инкрементировал
    // children_count и обновил active_leaf. Возвращаем id нового узла —
    // фронт будет ждать ответа модели и создаст A-узел следом.

    Ok(BranchResult {
        new_node_id: id,
        dialog_id: dialog_id.to_string(),
    })
}

/// Выбрать ветку в точке развилки (атомарно).
///
/// fork_node_id — A-узел развилки.
/// child_id     — выбранный Q-узел (одна из веток).
///
/// Делает за один заход:
/// 1. Сохраняет позицию текущей активной ветки в её Q-узле (last_visited_leaf_id).
/// 2. Переключает active_child развилки на выбранный Q-узел.
/// 3. Определяет лист выбранной ветки (запомненный или самый глубокий по active_child).
/// 4. Обновляет курсор диалога (active_leaf_id) на этот лист.
pub async fn select_branch(
    pool: &SqlitePool,
    dialog_id: &str,
    fork_node_id: &str,
    child_id: &str,
) -> Result<(), String> {
    let dialog = db::get_dialog(pool, dialog_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "dialog not found".to_string())?;

    let fork_node = db::get_node(pool, fork_node_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "fork node not found".to_string())?;

    // 1. Запоминаем текущую позицию у активной сейчас ветки.
    if let (Some(current_child), Some(leaf)) =
        (fork_node.active_child_id.clone(), dialog.active_leaf_id.clone())
    {
        db::set_last_visited_leaf(pool, &current_child, &leaf)
            .await
            .map_err(|e| e.to_string())?;
    }

    // 2. Переключаем активную ветку.
    db::set_active_child(pool, fork_node_id, child_id)
        .await
        .map_err(|e| e.to_string())?;

    // 3. Определяем целевой лист.
    let child = db::get_node(pool, child_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "child node not found".to_string())?;

    let start_id = child
        .last_visited_leaf_id
        .clone()
        .unwrap_or_else(|| child_id.to_string());

    let leaf_id = walk_to_leaf(pool, &start_id).await?;

    // 4. Обновляем курсор диалога.
    db::update_dialog_leaf(pool, dialog_id, &leaf_id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Спуститься по цепочке active_child от start_id до листа. Возвращает id листа.
async fn walk_to_leaf(pool: &SqlitePool, start_id: &str) -> Result<String, String> {
    let mut current = start_id.to_string();
    loop {
        let node = db::get_node(pool, &current)
            .await
            .map_err(|e| e.to_string())?;
        match node {
            Some(n) => match n.active_child_id {
                Some(child) => current = child,
                None => return Ok(current), // лист
            },
            None => return Ok(current),
        }
    }
}

/// Индикаторы глубины для UI.
#[derive(Debug, serde::Serialize)]
pub struct DepthIndicators {
    /// Полоски слева: глубина текущей ветки от корня.
    pub depth_left: usize,
    /// Полоски справа: количество узлов в активной ветке
    /// у которых есть неактивные дочерние ветки.
    pub branches_right: usize,
}

/// Рассчитать индикаторы глубины для текущей активной ветки диалога.
pub async fn get_depth_indicators(
    pool: &SqlitePool,
    dialog_id: &str,
) -> Result<DepthIndicators, String> {
    let branch = db::get_branch(pool, dialog_id)
        .await
        .map_err(|e| e.to_string())?;

    if branch.is_empty() {
        return Ok(DepthIndicators { depth_left: 0, branches_right: 0 });
    }

    let mut depth_left: usize = 0;
    let mut branches_right: usize = 0;

    for node in &branch {
        if let Some(parent_id) = &node.parent_id {
            let siblings = db::get_children(pool, parent_id)
                .await
                .map_err(|e| e.to_string())?;

            if siblings.len() > 1 {
                // У этого узла есть сёстры — мы на ответвлении
                depth_left += 1;
            }
        }

        // Считаем неактивные дочерние ветки у узлов активной ветки.
        // Используем children_count чтобы не грузить детей лишний раз,
        // но active_child_id != None означает что хотя бы один активен.
        if node.children_count > 1 {
            branches_right += 1;
        }
    }

    Ok(DepthIndicators { depth_left, branches_right })
}
