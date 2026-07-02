// src-tauri/src/tree/mod.rs

use crate::db;
use crate::markers;
use sqlx::SqlitePool;

/// Результат операции ветвления — возвращается в UI.
#[derive(Debug, serde::Serialize)]
pub struct BranchResult {
    pub new_node_id: String,
    pub dialog_id: String,
}

/// Засеять синтетический корневой анкор беседы (D-090).
///
/// Каждая беседа начинается со СКРЫТОЙ пары Q0->A0 (node_type='root_anchor'),
/// после чего реальный первый вопрос становится ребёнком A0. Так корень ведёт
/// себя как обычный узел после ответа A: маркер, '+', развилка работают на A0
/// переиспользованием общей механики, без особого случая 'сёстры без родителя'.
///
/// Анкоры пустые (content='') и не идут ни в ленту, ни в LLM — отсекаются по
/// node_type. На A0 сразу ставится корневой маркер #0 (зарезервирован; маркеры
/// пользователя начинаются с #1) с дефолтным комментарием (из i18n, правится).
///
/// Вызывается ОДИН раз сразу после db::create_dialog. Курсор диалога после
/// засева стоит на A0 — первый вопрос прицепится к нему.
pub async fn seed_root_anchor(
    pool: &SqlitePool,
    dialog_id: &str,
    root_marker_comment: &str,
) -> Result<(), String> {
    // Q0 — корневой анкор. parent=None => становится root_node_id диалога.
    let q0 = uuid::Uuid::new_v4().to_string();
    db::create_node(pool, &q0, dialog_id, None, "root_anchor", "", None, None, 0)
        .await
        .map_err(|e| e.to_string())?;

    // A0 — анкор-ответ под Q0. create_node проставит active_child у Q0 и сдвинет
    // курсор диалога на A0.
    let a0 = uuid::Uuid::new_v4().to_string();
    db::create_node(pool, &a0, dialog_id, Some(&q0), "root_anchor", "", None, None, 0)
        .await
        .map_err(|e| e.to_string())?;

    // Корневой маркер #0 на A0 (D-090). Пустой комментарий не пишем.
    let comment = if root_marker_comment.trim().is_empty() {
        None
    } else {
        Some(root_marker_comment)
    };
    markers::create_marker(pool, &a0, "#0", comment).await?;

    Ok(())
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

// ---------------------------------------------------------------------------
// Полное дерево беседы (плагин «Дерево»)
// ---------------------------------------------------------------------------

/// Узел полной топологии для визуализатора «Дерево». В отличие от NodeView
/// (обеднённая проекция для маркеров) несёт связи (parent/active_child), флаг
/// удаления, происхождение ответа (model/plugin) и extra (мета артефакта парсит
/// фронт, как в экспорте). Маркеры приложены сразу — дерево рисует их подписи
/// без отдельного запроса на узел.
#[derive(Debug, serde::Serialize)]
pub struct TreeNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub node_type: String,
    pub content: String,
    pub active_child_id: Option<String>,
    pub is_deleted: bool,
    pub model_id: Option<String>,
    pub plugin_id: Option<String>,
    pub extra: Option<String>,
    pub created_at: String,
    pub markers: Vec<markers::Marker>,
}

/// Полная топология беседы: ВСЕ узлы (включая удалённые и анкоры) + маркеры на
/// каждом. Дерево строит фронт по parent_id, активный путь — по active_child_id,
/// удалённые ветки прячет/приглушает по is_deleted. Маркеры берём одним запросом
/// на диалог и группируем по node_id (без N+1).
pub async fn get_full_tree(
    pool: &SqlitePool,
    dialog_id: &str,
) -> Result<Vec<TreeNode>, String> {
    let nodes = db::get_all_nodes(pool, dialog_id)
        .await
        .map_err(|e| e.to_string())?;

    let all_markers = markers::list_markers_for_dialog(pool, dialog_id).await?;
    let mut markers_by_node: std::collections::HashMap<String, Vec<markers::Marker>> =
        std::collections::HashMap::new();
    for m in all_markers {
        markers_by_node.entry(m.node_id.clone()).or_default().push(m);
    }

    Ok(nodes
        .into_iter()
        .map(|n| TreeNode {
            markers: markers_by_node.remove(&n.id).unwrap_or_default(),
            id: n.id,
            parent_id: n.parent_id,
            node_type: n.node_type,
            content: n.content,
            active_child_id: n.active_child_id,
            is_deleted: n.is_deleted,
            model_id: n.model_id,
            plugin_id: n.plugin_id,
            extra: n.extra,
            created_at: n.created_at,
        })
        .collect())
}

/// Сделать узел активным: провести активный путь от корня до node_id и поставить
/// на него курсор беседы. Нужно для двойного клика в дереве по узлу ЧУЖОЙ
/// (неактивной) ветки — после этого узел попадает в ленту и его можно
/// доскроллить (focusNode).
///
/// Шаги: 1) вверх до корня проставляем active_child = ребёнок-на-пути (так путь
/// корень→node становится активным); 2) вниз от node по существующим active_child
/// спускаемся к листу; 3) ставим курсор диалога на этот лист (лента = корень→лист
/// и проходит через node). Удалённый узел не активируем — некуда проваливаться.
pub async fn activate_path_to(pool: &SqlitePool, node_id: &str) -> Result<(), String> {
    let target = db::get_node(pool, node_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "node not found".to_string())?;

    if target.is_deleted {
        return Err("cannot navigate to a deleted node".to_string());
    }

    let dialog_id = target.dialog_id.clone();

    // 1. Вверх до корня: для каждого узла на пути делаем его активным ребёнком
    //    родителя. Корень (parent_id = None) завершает подъём.
    let mut current = target;
    while let Some(parent_id) = current.parent_id.clone() {
        db::set_active_child(pool, &parent_id, &current.id)
            .await
            .map_err(|e| e.to_string())?;
        current = db::get_node(pool, &parent_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "parent node not found".to_string())?;
    }

    // 2–3. Лист под целевым узлом (по активным детям) и курсор беседы на него.
    let leaf_id = walk_to_leaf(pool, node_id).await?;
    db::update_dialog_leaf(pool, &dialog_id, &leaf_id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
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