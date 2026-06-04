// src-tauri/src/keychain/mod.rs

use keyring::Entry;

const SERVICE: &str = "AiZavr";

/// Сохранить ключ провайдера в системный keychain.
/// provider_id — например "openrouter", "anthropic", "openai"
pub fn set_api_key(provider_id: &str, api_key: &str) -> Result<(), String> {
    Entry::new(SERVICE, provider_id)
        .map_err(|e| e.to_string())?
        .set_password(api_key)
        .map_err(|e| e.to_string())
}

/// Получить ключ провайдера из keychain.
/// Возвращает None если ключ не найден.
pub fn get_api_key(provider_id: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, provider_id)
        .map_err(|e| e.to_string())?;

    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Удалить ключ провайдера из keychain.
pub fn delete_api_key(provider_id: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, provider_id)
        .map_err(|e| e.to_string())?;

    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // уже нет — не ошибка
        Err(e) => Err(e.to_string()),
    }
}
