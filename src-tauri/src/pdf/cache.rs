use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use crate::pdf::types::PdfData;

// 简化的文档缓存 - 只保留基本功能
static DOCS_CACHE: Lazy<Mutex<HashMap<String, Arc<PdfData>>>> = 
    Lazy::new(|| Mutex::new(HashMap::new()));

// 简化的缓存统计
#[derive(serde::Serialize)]
pub struct CacheStats {
    pub docs_count: usize,
}

// 文档缓存管理
pub struct DocsCache;

impl DocsCache {
    pub fn insert(id: String, data: Arc<PdfData>) {
        let mut cache = DOCS_CACHE.lock();
        cache.insert(id, data);
    }

    pub fn get(id: &str) -> Option<Arc<PdfData>> {
        let cache = DOCS_CACHE.lock();
        cache.get(id).cloned()
    }

    pub fn remove(id: &str) -> Option<Arc<PdfData>> {
        let mut cache = DOCS_CACHE.lock();
        cache.remove(id)
    }
}

// 获取缓存统计信息
pub fn get_cache_stats() -> CacheStats {
    let docs_cache = DOCS_CACHE.lock();
    
    CacheStats {
        docs_count: docs_cache.len(),
    }
}

// 清理所有缓存
pub fn clear_all_caches() {
    let mut docs_cache = DOCS_CACHE.lock();
    docs_cache.clear();
    
    println!("🗑️ 所有缓存已清理");
}
