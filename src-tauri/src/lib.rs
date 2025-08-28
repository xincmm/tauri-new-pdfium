// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod pdf;

use anyhow::{anyhow, Result};
use pdf::*;
use tauri::{AppHandle, Manager};

// 全局静态变量存储 Pdfium 库路径，供 spawn_blocking 中使用
static PDFIUM_LIBRARY_PATH: once_cell::sync::OnceCell<String> = once_cell::sync::OnceCell::new();

// 异步处理瓦片请求
async fn handle_tile_request(uri: &str, app: &AppHandle) -> Result<Vec<u8>> {
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
    if let Some(buf) = TileCache::get(&key) {
        return Ok((*buf).clone());
    }

    // 获取PDF工作线程句柄
    let worker = app.state::<PdfWorkerHandle>();

    // 通过工作线程渲染瓦片
    let bytes = worker
        .inner()
        .render_tile(id, page, scale_x100, tx, ty)
        .map_err(|e| anyhow!("瓦片渲染失败: {}", e))?;

    // 缓存结果
    TileCache::put(key, std::sync::Arc::new(bytes.clone()));

    Ok(bytes)
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
                    Ok(bytes) => Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "image/webp")
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, &origin)
                        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS")
                        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
                        .header(header::CACHE_CONTROL, "public, max-age=31536000")
                        .body(bytes)
                        .unwrap(),
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
