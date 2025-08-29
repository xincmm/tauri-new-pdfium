

// 清理后的命令模块 - 只保留基本的缓存管理功能

#[tauri::command]
pub async fn get_cache_stats() -> Result<crate::pdf::cache::CacheStats, String> {
    Ok(crate::pdf::cache::get_cache_stats())
}

#[tauri::command]
pub async fn clear_caches() -> Result<(), String> {
    crate::pdf::cache::clear_all_caches();
    Ok(())
}
