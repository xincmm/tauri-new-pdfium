// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod pdf;

use anyhow::{anyhow, Result};
use pdf::*;
use tauri::{AppHandle, Manager};
use std::time::Instant;

// 全局静态变量存储 Pdfium 库路径，供 spawn_blocking 中使用
static PDFIUM_LIBRARY_PATH: once_cell::sync::OnceCell<String> = once_cell::sync::OnceCell::new();

// 性能统计结构
#[derive(Debug)]
struct TilePerformanceStats {
    total_time: std::time::Duration,
    cache_check_time: std::time::Duration,
    render_time: std::time::Duration,
    cache_store_time: std::time::Duration,
    // 渲染阶段详细统计
    setup_ms: f64,
    raster_ms: f64,
    pack_ms: f64,
    encode_ms: f64,
    pixel_width: i32,
    pixel_height: i32,
}

// 异步处理瓦片请求，返回数据和性能统计
async fn handle_tile_request(uri: &str, app: &AppHandle) -> Result<(Vec<u8>, TilePerformanceStats, f64)> {
    let total_start = Instant::now();
    let queue_start = Instant::now();
    
    let parts: Vec<&str> = uri.trim_matches('/').split('/').collect();

    let (id, page, scale, tx, ty) = match parts.as_slice() {
        [id, page_s, scale_s, tx_s, ty_s] => {
            let page: u32 = page_s.parse()?;
            let scale: f32 = scale_s.parse()?;
            let tx: u32 = tx_s.parse()?;
            let ty: u32 = ty_s.trim_end_matches(".webp").parse()?;
            (id.to_string(), page, scale, tx, ty)
        }
        [id, page_s, scale_s, tx_ty] => {
            let page: u32 = page_s.parse()?;
            let scale: f32 = scale_s.parse()?;
            let (tx_s, ty_s) = tx_ty
                .trim_end_matches(".webp")
                .split_once('_')
                .ok_or_else(|| anyhow!("bad tile token"))?;
            (id.to_string(), page, scale, tx_s.parse()?, ty_s.parse()?)
        }
        _ => return Err(anyhow!("bad tile path")),
    };

    let scale_x100 = (scale * 100.0).round() as u32;
    let key = TileKey {
        id: id.clone(),
        page,
        scale_x100,
        tx,
        ty,
    };

    // 检查瓦片缓存
    let cache_check_start = Instant::now();
    if let Some(buf) = TileCache::get(&key) {
        let cache_check_time = cache_check_start.elapsed();
        let total_time = total_start.elapsed();
        let stats = TilePerformanceStats {
            total_time,
            cache_check_time,
            render_time: std::time::Duration::ZERO, // 缓存命中，无渲染时间
            cache_store_time: std::time::Duration::ZERO,
            setup_ms: 0.0,
            raster_ms: 0.0,
            pack_ms: 0.0,
            encode_ms: 0.0,
            pixel_width: 0,
            pixel_height: 0,
        };
        return Ok(((*buf).clone(), stats, 0.0)); // 缓存命中，无队列等待
    }
    let cache_check_time = cache_check_start.elapsed();

    // 获取PDF工作线程句柄
    let worker = app.state::<PdfWorkerHandle>();

    // 通过工作线程渲染瓦片
    let queue_ms = queue_start.elapsed().as_secs_f64() * 1000.0;
    let render_start = Instant::now();
    let render_result = worker
        .inner()
        .render_tile(id, page, scale_x100, tx, ty)
        .map_err(|e| anyhow!("瓦片渲染失败: {}", e))?;
    let render_time = render_start.elapsed();

    // 缓存结果
    let cache_store_start = Instant::now();
    TileCache::put(key, std::sync::Arc::new(render_result.data.clone()));
    let cache_store_time = cache_store_start.elapsed();

    let total_time = total_start.elapsed();
    let stats = TilePerformanceStats {
        total_time,
        cache_check_time,
        render_time,
        cache_store_time,
        setup_ms: render_result.setup_ms,
        raster_ms: render_result.raster_ms,
        pack_ms: render_result.pack_ms,
        encode_ms: render_result.encode_ms,
        pixel_width: render_result.pixel_width,
        pixel_height: render_result.pixel_height,
    };

    Ok((render_result.data, stats, queue_ms))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_pdf,
            get_page_text_layout,
            extract_text_range,
            close_pdf,
            crate::pdf::commands::get_cache_stats,
            clear_caches
        ])
        .setup(|app| {
            use tauri::path::BaseDirectory;

            let rel_path = if cfg!(target_os = "macos") {
                "sidecars/libpdfium.dylib-aarch64-apple-darwin"
            } else if cfg!(target_os = "windows") {
                "sidecars/pdfium.dll"
            } else {
                "sidecars/libpdfium.so"
            };

            let lib_path = app
                .path()
                .resolve(rel_path, BaseDirectory::Resource)
                .unwrap_or_else(|_| std::path::PathBuf::from(rel_path));

            let library_path = lib_path.to_string_lossy().to_string();

            // 设置全局 Pdfium 库路径
            PDFIUM_LIBRARY_PATH.set(library_path.clone()).unwrap();

            // 启动PDF工作线程
            let worker =
                spawn_pdf_worker(library_path.clone()).expect("Failed to spawn PDF worker");

            // 注册状态
            app.manage(PdfiumLibraryPath(library_path));
            app.manage(worker);

            println!("🚀 Tauri应用初始化完成，PDF工作线程已启动");
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("tiles", |ctx, request, responder| {
            use tauri::http::{header, Method, Response, StatusCode};

            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            let origin = request
                .headers()
                .get(header::ORIGIN)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("*")
                .to_string();

            // 处理CORS预检请求
            if request.method() == Method::OPTIONS {
                return responder.respond(
                    Response::builder()
                        .status(StatusCode::NO_CONTENT)
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, &origin)
                        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, OPTIONS")
                        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
                        .body(Vec::new())
                        .unwrap(),
                );
            }

            // 异步处理瓦片请求
            tauri::async_runtime::spawn(async move {
                let response = match handle_tile_request(&path, &app).await {
                    Ok((bytes, stats, queue_ms)) => {
                        let write_start = Instant::now();
                        
                        // 构建详细的Server-Timing头，包含队列等待时间
                        let server_timing = format!(
                            "queue;dur={:.2}, setup;dur={:.2}, raster;dur={:.2}, pack;dur={:.2}, encode;dur={:.2}, total;dur={:.2}",
                            queue_ms,
                            stats.setup_ms,
                            stats.raster_ms,
                            stats.pack_ms,
                            stats.encode_ms,
                            stats.total_time.as_secs_f64() * 1000.0
                        );
                        
                        // 像素信息头
                        let pixel_info = format!("{}x{}", stats.pixel_width, stats.pixel_height);
                        let content_length = bytes.len().to_string();
                        
                        // 构建响应 - 确保一次性完整传输
                        let response = Response::builder()
                            .status(StatusCode::OK)
                            .header(header::CONTENT_TYPE, "image/webp")
                            .header(header::CONTENT_LENGTH, &content_length)  // 关键：明确长度
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, &origin)
                            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS")
                            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
                            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")  // 添加immutable
                            .header("Timing-Allow-Origin", "*")  // 允许前端读取timing
                            .header("Server-Timing", server_timing)
                            .header("X-Pixels", pixel_info)
                            .body(bytes)  // 完整字节一次性传输
                            .unwrap();
                            
                        let write_ms = write_start.elapsed().as_secs_f64() * 1000.0;
                        
                        // 记录传输性能
                        println!("📤 传输完成: {}KB | 传输时间={:.2}ms | 服务端总计={:.2}ms", 
                            content_length.parse::<usize>().unwrap() / 1024,
                            write_ms,
                            stats.total_time.as_secs_f64() * 1000.0
                        );
                        
                        response
                    },
                    Err(e) => Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header(header::CONTENT_TYPE, "text/plain")
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, &origin)
                        .body(format!("tile error: {}", e).into_bytes())
                        .unwrap(),
                };

                responder.respond(response);
            });
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
