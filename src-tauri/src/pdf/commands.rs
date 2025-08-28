use crate::pdf::cache::DocsCache;
use crate::pdf::types::*;
use crate::pdf::worker::PdfWorkerHandle;
use anyhow::Result;
use std::sync::Arc;
use tauri::State;

// 全局状态，存储 Pdfium 库的路径
pub struct PdfiumLibraryPath(pub String);

#[tauri::command]
pub async fn open_pdf(
    path: String,
    worker: State<'_, PdfWorkerHandle>,
) -> Result<PdfMetadata, String> {
    let start_time = std::time::Instant::now();

    // 读取文件字节数据
    let bytes = std::fs::read(&path).map_err(|e| format!("文件读取失败: {}", e))?;

    // 通过工作线程打开文档
    let metadata = worker
        .inner()
        .open_document(bytes.clone())
        .map_err(|e| format!("PDF文档打开失败: {}", e))?;

    // 仍可把 dims/bytes 备份进 DOCS 用于其他 UI 逻辑，但渲染/文本已不依赖它
    let data = Arc::new(PdfData {
        bytes,
        page_dims: metadata.page_dims.clone(),
    });
    DocsCache::insert(metadata.id.clone(), data);

    println!("✅ PDF 处理完成，耗时: {:?}", start_time.elapsed());
    Ok(metadata)
}

#[tauri::command]
pub async fn get_page_text_layout(
    id: String,
    page: u32,
    worker: State<'_, PdfWorkerHandle>,
) -> Result<PageTextLayout, String> {
    worker
        .inner()
        .get_text_layout(id, page)
        .map_err(|e| format!("文本布局获取失败: {}", e))
}

#[tauri::command]
pub async fn extract_text_range(
    id: String,
    page: u32,
    start: u32,
    end: u32,
    worker: State<'_, PdfWorkerHandle>,
) -> Result<String, String> {
    worker
        .inner()
        .extract_text_range(id, page, start, end)
        .map_err(|e| format!("文本范围提取失败: {}", e))
}

#[tauri::command]
pub async fn close_pdf(id: String, worker: State<'_, PdfWorkerHandle>) -> Result<(), String> {
    // 从缓存中移除
    DocsCache::remove(&id);

    // 通知工作线程关闭文档
    worker
        .inner()
        .close_document(id)
        .map_err(|e| format!("文档关闭失败: {}", e))
}

#[tauri::command]
pub async fn get_cache_stats() -> Result<crate::pdf::cache::CacheStats, String> {
    Ok(crate::pdf::cache::get_cache_stats())
}

#[tauri::command]
pub async fn clear_caches() -> Result<(), String> {
    crate::pdf::cache::clear_all_caches();
    Ok(())
}
