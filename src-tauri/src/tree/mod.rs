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

    Ok(BranchResult {
        new_node_id: id,
        dialog_id: dialog_id.to_string(),
    })
}

/// Выбрать ветку в точке развилки (атомарно).
///
/// fork_node_id — A-узел развилки.
/// child_id     — выбранный Q-узел (одна из веток).
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

/// Мягкое удаление ветки (атомарно, D-048, D-049).
///
/// fork_node_id — A-узел развилки (родитель удаляемого Q-узла).
/// child_id     — Q-узел удаляемой ветки.
///
/// Последовательность:
/// 1. Проверяет что видимых веток > 1 (запрет удаления последней, D-049).
/// 2. Если child_id — активная ветка, сначала переключается на другую видимую.
/// 3. Помечает child_id и всё его поддерево как is_deleted = 1.
pub async fn delete_branch_atomic(
    pool: &SqlitePool,
    dialog_id: &str,
    fork_node_id: &str,
    child_id: &str,
) -> Result<(), String> {
    // 1. Считаем видимые ветки.
    let visible = db::get_children(pool, fork_node_id)
        .await
        .map_err(|e| e.to_string())?;

    if visible.len() <= 1 {
        return Err("cannot delete last visible branch".to_string());
    }

    // 2. Если удаляем активную ветку — сначала переключиться.
    let fork_node = db::get_node(pool, fork_node_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "fork node not found".to_string())?;

    if fork_node.active_child_id.as_deref() == Some(child_id) {
        let other = visible
            .iter()
            .find(|n| n.id != child_id)
            .ok_or_else(|| "no other visible branch found".to_string())?;

        let other_id = other.id.clone();
        select_branch(pool, dialog_id, fork_node_id, &other_id).await?;
    }

    // 3. Мягкое удаление поддерева.
    db::delete_branch(pool, child_id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Восстановление удалённой ветки (D-050).
/// Снимает is_deleted с узла и всего поддерева.
/// Навигацию не меняет — пользователь сам переходит в ветку если нужно.
pub async fn restore_branch_atomic(
    pool: &SqlitePool,
    node_id: &str,
) -> Result<(), String> {
    db::restore_branch(pool, node_id)
        .await
        .map_err(|e| e.to_string())
}

/// Спуститься по цепочке active_child от start_id до листа.
async fn walk_to_leaf(pool: &SqlitePool, start_id: &str) -> Result<String, String> {
    let mut current = start_id.to_string();
    loop {
        let node = db::get_node(pool, &current)
            .await
            .map_err(|e| e.to_string())?;
        match node {
            Some(n) => match n.active_child_id {
                Some(child) => current = child,
                None => return Ok(current),
            },
            None => return Ok(current),
        }
    }
}

/// Индикаторы глубины для UI.
#[derive(Debug, serde::Serialize)]
pub struct DepthIndicators {
    pub depth_left: usize,
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
        // depth_left: узел находится на ответвлении (есть видимые сёстры).
        if let Some(parent_id) = &node.parent_id {
            let siblings = db::get_children(pool, parent_id)
                .await
                .map_err(|e| e.to_string())?;
            if siblings.len() > 1 {
                depth_left += 1;
            }
        }

        // branches_right: у узла есть несколько видимых дочерних веток.
        // Используем get_children (фильтрует is_deleted=0), а не children_count
        // — children_count считает всех включая удалённые.
        let children = db::get_children(pool, &node.id)
            .await
            .map_err(|e| e.to_string())?;
        if children.len() > 1 {
            branches_right += 1;
        }
    }

    Ok(DepthIndicators { depth_left, branches_right })
}