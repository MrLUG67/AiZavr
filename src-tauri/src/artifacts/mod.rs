// Артефакты в дереве беседы (D-023, D-091, D-092): хранение, плашка, открытие через ОС.

use crate::db::{self, DbNode};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Audio,
    Video,
    Model3d,
    Document,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactExtra {
    pub media_kind: MediaKind,
    pub filename: String,
    pub extension: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    pub size_bytes: u64,
    /// Относительный путь от data_dir, напр. `artifacts/{id}.png`
    pub storage_path: String,
}

pub fn artifacts_dir(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join("artifacts")
}

pub fn infer_media_kind(ext: &str) -> MediaKind {
    let e = ext.trim_start_matches('.').to_ascii_lowercase();
    match e.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "heic" | "avif"
        | "tiff" | "tif" => MediaKind::Image,
        "mp3" | "wav" | "flac" | "ogg" | "oga" | "aac" | "m4a" | "wma" | "opus" => {
            MediaKind::Audio
        }
        "mp4" | "webm" | "mkv" | "avi" | "mov" | "m4v" | "wmv" | "mpeg" | "mpg" => {
            MediaKind::Video
        }
        "glb" | "gltf" | "obj" | "fbx" | "stl" | "ply" | "dae" | "3ds" | "blend" => {
            MediaKind::Model3d
        }
        "pdf" | "doc" | "docx" | "txt" | "md" | "rtf" | "odt" | "xls" | "xlsx" | "ppt"
        | "pptx" | "csv" => MediaKind::Document,
        _ => MediaKind::Other,
    }
}

pub fn extension_from_filename(filename: &str) -> String {
    Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "bin".to_string())
}

fn parse_artifact_extra(extra: &Option<String>) -> Result<ArtifactExtra, String> {
    let raw = extra.as_ref().ok_or("artifact node has no extra")?;
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid artifact extra JSON: {e}"))?;
    let artifact = v
        .get("artifact")
        .ok_or("extra.artifact missing")?;
    serde_json::from_value(artifact.clone())
        .map_err(|e| format!("invalid artifact metadata: {e}"))
}

fn wrap_extra(artifact: &ArtifactExtra) -> String {
    serde_json::json!({ "artifact": artifact }).to_string()
}

/// Куда крепить новый артефакт: активный лист, но не под служебную заглушку.
pub async fn resolve_attach_parent(
    pool: &SqlitePool,
    dialog_id: &str,
) -> Result<String, String> {
    let dialog = db::get_dialog(pool, dialog_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("dialog not found")?;

    let leaf_id = dialog
        .active_leaf_id
        .ok_or("dialog has no active leaf")?;

    let leaf = db::get_node(pool, &leaf_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("active leaf not found")?;

    if leaf.node_type == "unanswered_placeholder" {
        return Err("Нельзя вставить файл, пока ожидается ответ модели".into());
    }
    if leaf.node_type == "compression_placeholder" || leaf.node_type == "root_anchor" {
        return Err("Нельзя вставить файл в служебный узел".into());
    }

    Ok(leaf_id)
}

/// Скопировать файл с диска пользователя в хранилище и создать узел artifact.
pub async fn attach_from_path(
    pool: &SqlitePool,
    data_dir: &str,
    dialog_id: &str,
    source_path: &str,
) -> Result<DbNode, String> {
    let source = Path::new(source_path);
    if !source.is_file() {
        return Err(format!("file not found: {source_path}"));
    }

    let parent_id = resolve_attach_parent(pool, dialog_id).await?;

    let filename = source
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();

    let extension = extension_from_filename(&filename);
    let media_kind = infer_media_kind(&extension);
    let size_bytes = fs::metadata(source)
        .map_err(|e| e.to_string())?
        .len();

    let node_id = uuid::Uuid::new_v4().to_string();
    let rel_path = format!("artifacts/{}.{}", node_id, extension);
    let dest = artifacts_dir(data_dir).join(format!("{}.{}", node_id, extension));

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(source, &dest).map_err(|e| format!("copy failed: {e}"))?;

    let artifact = ArtifactExtra {
        media_kind,
        filename: filename.clone(),
        extension: extension.clone(),
        mime: None,
        size_bytes,
        storage_path: rel_path,
    };

    let extra_json = wrap_extra(&artifact);
    db::create_artifact_node(
        pool,
        &node_id,
        dialog_id,
        &parent_id,
        &filename,
        &extra_json,
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentExtra {
    pub media_kind: MediaKind,
    pub filename: String,
    pub extension: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    pub size_bytes: u64,
    pub storage_path: String,
}

#[derive(Debug, Deserialize)]
pub struct MediaInput {
    pub mime: String,
    pub extension: String,
    pub base64: String,
}

fn parse_attachments_extra(extra: &Option<String>) -> Result<Vec<AttachmentExtra>, String> {
    let raw = extra.as_ref().ok_or("message has no extra")?;
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid extra JSON: {e}"))?;
    let arr = v
        .get("attachments")
        .and_then(|a| a.as_array())
        .ok_or("extra.attachments missing")?;
    arr.iter()
        .map(|item| {
            serde_json::from_value(item.clone())
                .map_err(|e| format!("invalid attachment metadata: {e}"))
        })
        .collect()
}

/// Сохранить бинарные части ответа LLM на диск и собрать extra.attachments.
///
/// УСТОЙЧИВО: ошибка на одной картинке (битый base64, отказ записи) НЕ роняет
/// весь ответ — проблемная картинка пропускается с логом, остальные сохраняются.
/// Так текст ответа и валидные картинки всегда доходят до пользователя.
pub fn persist_llm_media(
    data_dir: &str,
    node_id: &str,
    media: &[MediaInput],
) -> Vec<AttachmentExtra> {
    if media.is_empty() {
        return vec![];
    }

    let dir = artifacts_dir(data_dir);
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("persist_llm_media: cannot create artifacts dir: {e}");
        return vec![];
    }

    let mut out = Vec::with_capacity(media.len());
    for (i, item) in media.iter().enumerate() {
        let extension = item
            .extension
            .trim_start_matches('.')
            .to_ascii_lowercase();
        let ext = if extension.is_empty() { "bin".to_string() } else { extension };
        let media_kind = infer_media_kind(&ext);
        let rel_path = format!("artifacts/{}-{}.{}", node_id, i, ext);
        let dest = dir.join(format!("{}-{}.{}", node_id, i, ext));

        let bytes = match base64_decode(&item.base64) {
            Ok(b) => b,
            Err(e) => {
                eprintln!(
                    "persist_llm_media: skip image {i} (mime={}, b64_len={}): {e}",
                    item.mime,
                    item.base64.len()
                );
                continue;
            }
        };

        if let Err(e) = fs::write(&dest, &bytes) {
            eprintln!("persist_llm_media: skip image {i} (write failed): {e}");
            continue;
        }

        let filename = format!("image-{}.{}", i + 1, ext);
        out.push(AttachmentExtra {
            media_kind,
            filename,
            extension: ext.clone(),
            mime: Some(item.mime.clone()),
            size_bytes: bytes.len() as u64,
            storage_path: rel_path,
        });
    }

    eprintln!(
        "persist_llm_media: node={node_id} requested={} saved={}",
        media.len(),
        out.len()
    );
    out
}

/// Терпимое декодирование: срезаем возможный data:-префикс, чистим пробелы/перевод
/// строк, пробуем стандартный и URL-safe алфавиты, со строгим и нестрогим паддингом.
fn base64_decode(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;

    let trimmed = data.trim();
    let payload = match trimmed.find(";base64,") {
        Some(idx) => &trimmed[idx + ";base64,".len()..],
        None => trimmed,
    };
    let cleaned: String = payload.chars().filter(|c| !c.is_whitespace()).collect();

    let engines = [
        base64::engine::general_purpose::STANDARD,
        base64::engine::general_purpose::STANDARD_NO_PAD,
        base64::engine::general_purpose::URL_SAFE,
        base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ];

    let mut last_err = String::from("empty base64");
    for engine in engines {
        match engine.decode(cleaned.as_bytes()) {
            Ok(bytes) => return Ok(bytes),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!("invalid base64: {last_err}"))
}

pub fn materialize_attachment(data_dir: &str, meta: &AttachmentExtra) -> PathBuf {
    materialize_path(data_dir, &ArtifactExtra {
        media_kind: meta.media_kind.clone(),
        filename: meta.filename.clone(),
        extension: meta.extension.clone(),
        mime: meta.mime.clone(),
        size_bytes: meta.size_bytes,
        storage_path: meta.storage_path.clone(),
    })
}

pub async fn open_message_attachment(
    pool: &SqlitePool,
    data_dir: &str,
    message_node_id: &str,
    index: usize,
) -> Result<(), String> {
    let node = db::get_node(pool, message_node_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("node not found")?;

    if node.node_type != "assistant_message" {
        return Err(format!("node {} is not an assistant_message", message_node_id));
    }

    let attachments = parse_attachments_extra(&node.extra)?;
    let meta = attachments
        .get(index)
        .ok_or_else(|| format!("attachment index {index} out of range"))?;

    let path = materialize_attachment(data_dir, meta);
    if !path.is_file() {
        return Err(format!("attachment file missing on disk: {}", path.display()));
    }
    open::that(&path).map_err(|e| format!("open failed: {e}"))
}

pub fn materialize_path(data_dir: &str, meta: &ArtifactExtra) -> PathBuf {
    PathBuf::from(data_dir).join(&meta.storage_path)
}

pub async fn materialize(
    pool: &SqlitePool,
    data_dir: &str,
    node_id: &str,
) -> Result<PathBuf, String> {
    let node = db::get_node(pool, node_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("node not found")?;

    if node.node_type != "artifact" {
        return Err(format!("node {} is not an artifact", node_id));
    }

    let meta = parse_artifact_extra(&node.extra)?;
    let path = materialize_path(data_dir, &meta);
    if !path.is_file() {
        return Err(format!("artifact file missing on disk: {}", path.display()));
    }
    Ok(path)
}

pub async fn open_with_os(
    pool: &SqlitePool,
    data_dir: &str,
    node_id: &str,
) -> Result<(), String> {
    let path = materialize(pool, data_dir, node_id).await?;
    open::that(&path).map_err(|e| format!("open failed: {e}"))
}
