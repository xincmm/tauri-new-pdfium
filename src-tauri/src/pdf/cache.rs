use crate::pdf::types::*;
use lru::LruCache;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::num::NonZeroUsize;
use std::sync::Arc;

// 全局缓存实例
static TILE_CACHE: Lazy<Mutex<LruCache<TileKey, Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(NonZeroUsize::new(300).unwrap())));

static PAGE_CACHE: Lazy<Mutex<LruCache<PageKey, Arc<image::DynamicImage>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(NonZeroUsize::new(30).unwrap())));

static DOCS: Lazy<Mutex<std::collections::HashMap<String, Arc<PdfData>>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

// 正在渲染的页面跟踪，避免重复渲染
static RENDERING_PAGES: Lazy<Mutex<std::collections::HashSet<RenderingKey>>> =
    Lazy::new(|| Mutex::new(std::collections::HashSet::new()));

/// 瓦片缓存管理
pub struct TileCache;

impl TileCache {
    pub fn get(key: &TileKey) -> Option<Arc<Vec<u8>>> {
        TILE_CACHE.lock().get(key).cloned()
    }

    pub fn put(key: TileKey, value: Arc<Vec<u8>>) {
        TILE_CACHE.lock().put(key, value);
    }

    pub fn clear() {
        TILE_CACHE.lock().clear();
    }

    pub fn len() -> usize {
        TILE_CACHE.lock().len()
    }
}

/// 页面缓存管理
pub struct PageCache;

impl PageCache {
    pub fn get(key: &PageKey) -> Option<Arc<image::DynamicImage>> {
        PAGE_CACHE.lock().get(key).cloned()
    }

    pub fn put(key: PageKey, value: Arc<image::DynamicImage>) {
        PAGE_CACHE.lock().put(key, value);
    }

    pub fn clear() {
        PAGE_CACHE.lock().clear();
    }

    pub fn len() -> usize {
        PAGE_CACHE.lock().len()
    }
}

/// 文档数据缓存管理
pub struct DocsCache;

impl DocsCache {
    pub fn get(id: &str) -> Option<Arc<PdfData>> {
        DOCS.lock().get(id).cloned()
    }

    pub fn insert(id: String, data: Arc<PdfData>) {
        DOCS.lock().insert(id, data);
    }

    pub fn remove(id: &str) -> Option<Arc<PdfData>> {
        DOCS.lock().remove(id)
    }

    pub fn clear() {
        DOCS.lock().clear();
    }

    pub fn len() -> usize {
        DOCS.lock().len()
    }
}

/// 渲染状态管理
pub struct RenderingState;

impl RenderingState {
    pub fn is_rendering(key: &RenderingKey) -> bool {
        RENDERING_PAGES.lock().contains(key)
    }

    pub fn start_rendering(key: RenderingKey) -> bool {
        RENDERING_PAGES.lock().insert(key)
    }

    pub fn finish_rendering(key: &RenderingKey) -> bool {
        RENDERING_PAGES.lock().remove(key)
    }

    pub fn clear() {
        RENDERING_PAGES.lock().clear();
    }

    pub fn len() -> usize {
        RENDERING_PAGES.lock().len()
    }
}

/// 缓存统计信息
#[derive(Debug, serde::Serialize)]
pub struct CacheStats {
    pub tile_cache_size: usize,
    pub page_cache_size: usize,
    pub docs_cache_size: usize,
    pub rendering_count: usize,
}

/// 获取缓存统计信息
pub fn get_cache_stats() -> CacheStats {
    CacheStats {
        tile_cache_size: TileCache::len(),
        page_cache_size: PageCache::len(),
        docs_cache_size: DocsCache::len(),
        rendering_count: RenderingState::len(),
    }
}

/// 清空所有缓存
pub fn clear_all_caches() {
    TileCache::clear();
    PageCache::clear();
    DocsCache::clear();
    RenderingState::clear();
    println!("🧹 所有缓存已清空");
}
