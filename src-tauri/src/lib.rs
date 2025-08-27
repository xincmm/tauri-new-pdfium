// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use anyhow::{anyhow, Result};
use image::{imageops::crop_imm, GenericImageView};
use lru::LruCache;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::{collections::HashMap, num::NonZeroUsize, sync::Arc};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use std::time::Instant;

const TILE_SIZE: u32 = 512;
// 降低BASE_DPI以提升性能，144 DPI在大多数情况下已足够清晰
const BASE_DPI: f32 = 144.0;
const WEBP_QUALITY: u8 = 80;
// 最大DPI限制，防止内存过度使用
const MAX_DPI: f32 = 600.0;
// 最小DPI限制，确保低分辨率瓦片仍有合理质量
const MIN_DPI: f32 = 36.0;

struct PdfData {
    bytes: Vec<u8>,
    page_dims: Vec<(f32, f32)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TileKey {
    id: String,
    page: u32,
    scale_x100: u32,
    tx: u32,
    ty: u32,
}

// 页面图像缓存，存储整页渲染结果
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PageKey {
    id: String,
    page: u32,
    scale_x100: u32,
}

static DOCS: Lazy<Mutex<HashMap<String, Arc<PdfData>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static TILE_CACHE: Lazy<Mutex<LruCache<TileKey, Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(NonZeroUsize::new(200).unwrap())));
// 页面图像缓存，减少重复渲染
static PAGE_CACHE: Lazy<Mutex<LruCache<PageKey, Arc<image::DynamicImage>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(NonZeroUsize::new(20).unwrap())));

#[derive(Serialize, Deserialize, Debug)]
pub struct PdfMetadata {
    id: String,
    total_pages: u32,
    page_dims: Vec<(f32, f32)>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TextItem {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    font_size: f32,
    font_name: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PageTextContent {
    page: u32,
    text_items: Vec<TextItem>,
}

// 单字符的包围盒（单位 pt）
#[derive(Serialize, Deserialize, Debug)]
pub struct CharBox {
    pub idx: u32,     // 在该页文本流里的顺序索引
    pub ch: String,   // 单字符（可能是空格/连字符等）
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PageTextLayout {
    pub width_pt: f32,
    pub height_pt: f32,
    pub chars: Vec<CharBox>,
}

// 全局状态，存储 Pdfium 库的路径
pub struct PdfiumLibraryPath(pub String);

#[tauri::command]
async fn open_pdf(
    path: String,
    state: tauri::State<'_, PdfiumLibraryPath>,
) -> Result<PdfMetadata, String> {
    println!("🔄 开始处理 PDF 文件: {}", path);

    println!("🔗 正在绑定 Pdfium 库，路径: {}", state.0);
    let bindings = Pdfium::bind_to_library(&state.0)
        .or_else(|e1| {
            eprintln!("⚠️ 绑定到指定库失败: {}, 尝试系统库", e1);
            Pdfium::bind_to_system_library().map_err(|e2| {
                format!(
                    "无法绑定到 Pdfium 库 - 指定库错误: {}, 系统库错误: {}",
                    e1, e2
                )
            })
        })
        .map_err(|e| {
            eprintln!("❌ Pdfium 库绑定完全失败: {}", e);
            e
        })?;
    println!("✅ Pdfium 库绑定成功");

    println!("🏗️ 正在创建 Pdfium 实例...");
    let pdfium = Pdfium::new(bindings);
    println!("✅ Pdfium 实例创建成功");

    println!("📄 正在加载 PDF 文档...");
    let doc = pdfium.load_pdf_from_file(&path, None).map_err(|e| {
        let error = format!("PDF 文档加载失败: {}", e);
        eprintln!("❌ {}", error);
        error
    })?;
    println!("✅ PDF 文档加载成功");

    println!("📊 正在获取页面信息...");
    let pages = doc.pages();
    let total_pages = pages.len() as u32;
    println!("📄 总页数: {}", total_pages);

    println!("📏 正在获取页面尺寸...");
    let page_dims: Vec<(f32, f32)> = pages
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let dims = (p.width().value, p.height().value);
            println!("  页面 {}: {}x{}", i + 1, dims.0, dims.1);
            dims
        })
        .collect();
    println!("✅ 页面尺寸获取完成");

    println!("🆔 正在生成文档 ID...");
    let id = Uuid::new_v4().to_string();
    println!("✅ 文档 ID: {}", id);

    println!("💾 正在缓存文档数据...");
    // 读取文件字节数据用于缓存
    let bytes = fs::read(&path).map_err(|e| {
        let error = format!("文件读取失败: {}", e);
        eprintln!("❌ {}", error);
        error
    })?;

    let data = Arc::new(PdfData {
        bytes,
        page_dims: page_dims.clone(),
    });
    DOCS.lock().insert(id.clone(), data);
    println!("✅ 文档数据缓存完成");

    let metadata = PdfMetadata {
        id,
        total_pages,
        page_dims,
    };

    println!("🎉 PDF 处理完成，返回元数据");
    Ok(metadata)
}

#[tauri::command]
async fn get_page_text_layout(
    id: String,
    page: u32,
) -> Result<PageTextLayout, String> {
    println!("📐 获取页面文本布局: id={}, page={}", id, page);

    // 获取文档数据
    let data_arc = DOCS
        .lock()
        .get(&id)
        .ok_or_else(|| "doc not found".to_string())?
        .clone();

    let (w_pt, h_pt) = data_arc.page_dims[page as usize];
    let data_bytes = data_arc.bytes.clone();
    
    // 在spawn_blocking中执行CPU密集型的Pdfium操作
    let layout = tauri::async_runtime::spawn_blocking(move || -> Result<PageTextLayout, String> {
        // 重新绑定Pdfium库
        let library_path = if cfg!(target_os = "macos") {
            "sidecars/libpdfium.dylib-aarch64-apple-darwin"
        } else if cfg!(target_os = "windows") {
            "sidecars/pdfium.dll"
        } else {
            "sidecars/libpdfium.so"
        };

        let bindings = Pdfium::bind_to_library(library_path)
            .or_else(|_| Pdfium::bind_to_system_library())
            .map_err(|e| format!("Failed to bind Pdfium library: {}", e))?;
        let pdfium = Pdfium::new(bindings);

        let doc = pdfium.load_pdf_from_byte_slice(&data_bytes, None)
            .map_err(|e| format!("Failed to load PDF: {}", e))?;

        let pdf_page = doc.pages().get(page as u16)
            .map_err(|e| format!("Page out of range: {}", e))?;

        // 获取页面文本对象
        let mut chars = Vec::new();
        
        // 使用 Pdfium 的文本提取功能
        if let Ok(text_page) = pdf_page.text() {
            let char_count = text_page.chars().len();
            println!("📝 页面 {} 包含 {} 个字符", page, char_count);

            // 遍历所有字符，提取位置信息
            for (i, char_obj) in text_page.chars().iter().enumerate() {
                let char_text = char_obj.unicode_char().unwrap_or(' ').to_string();
                
                // 获取字符的边界框
                if let Ok(bounds) = char_obj.loose_bounds() {
                    chars.push(CharBox {
                        idx: i as u32,
                        ch: char_text,
                        left: bounds.left().value,
                        top: bounds.top().value,
                        right: bounds.right().value,
                        bottom: bounds.bottom().value,
                    });
                }
            }

            println!("✅ 提取到 {} 个字符框", chars.len());
        } else {
            println!("⚠️ 无法获取页面文本对象");
        }

        Ok(PageTextLayout {
            width_pt: w_pt,
            height_pt: h_pt,
            chars,
        })
    }).await.map_err(|e| format!("Task join error: {}", e))??;

    println!("🎉 页面文本布局提取完成");
    Ok(layout)
}

/// （可选）按字符区间提词（若想后端做规范化则可用）
#[tauri::command]
async fn extract_text_range(
    id: String,
    page: u32,
    start: u32,
    end: u32,
) -> Result<String, String> {
    println!("📝 提取文本范围: id={}, page={}, start={}, end={}", id, page, start, end);

    // 获取文档数据
    let data_arc = DOCS
        .lock()
        .get(&id)
        .ok_or_else(|| "doc not found".to_string())?
        .clone();

    let data_bytes = data_arc.bytes.clone();
    
    // 在spawn_blocking中执行CPU密集型的Pdfium操作
    let text = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // 重新绑定Pdfium库
        let library_path = if cfg!(target_os = "macos") {
            "sidecars/libpdfium.dylib-aarch64-apple-darwin"
        } else if cfg!(target_os = "windows") {
            "sidecars/pdfium.dll"
        } else {
            "sidecars/libpdfium.so"
        };

        let bindings = Pdfium::bind_to_library(library_path)
            .or_else(|_| Pdfium::bind_to_system_library())
            .map_err(|e| format!("Failed to bind Pdfium library: {}", e))?;
        let pdfium = Pdfium::new(bindings);

        let doc = pdfium.load_pdf_from_byte_slice(&data_bytes, None)
            .map_err(|e| format!("Failed to load PDF: {}", e))?;

        let pdf_page = doc.pages().get(page as u16)
            .map_err(|e| format!("Page out of range: {}", e))?;

        // 获取页面文本对象
        let mut result = String::new();
        
        // 使用 Pdfium 的文本提取功能
        if let Ok(text_page) = pdf_page.text() {
            // 遍历指定范围的字符
            for (i, char_obj) in text_page.chars().iter().enumerate() {
                let idx = i as u32;
                if idx >= start && idx <= end {
                    result.push(char_obj.unicode_char().unwrap_or(' '));
                }
            }
        }

        Ok(result)
    }).await.map_err(|e| format!("Task join error: {}", e))??;

    println!("🎉 文本范围提取完成，长度: {}", text.len());
    Ok(text)
}

// 获取或创建页面图像（异步版本，利用thread_safe特性）
async fn ensure_page_image(data: &PdfData, page: u32, scale_x100: u32) -> Result<Arc<image::DynamicImage>> {
    let page_key = PageKey {
        id: "temp".to_string(), // 这里简化处理，实际应该用真实ID
        page,
        scale_x100,
    };

    // 检查页面缓存
    if let Some(cached_img) = PAGE_CACHE.lock().get(&page_key) {
        println!("✅ 页面图像缓存命中: page={}, scale={}", page, scale_x100 as f32 / 100.0);
        return Ok(cached_img.clone());
    }

    let t0 = Instant::now();
    println!("🎨 开始渲染整页图像: page={}, scale={}", page, scale_x100 as f32 / 100.0);

    let data_bytes = data.bytes.clone();
    let page_dims = data.page_dims[page as usize];
    
    // 在spawn_blocking中执行CPU密集型的Pdfium操作
    let page_img = tauri::async_runtime::spawn_blocking(move || -> Result<image::DynamicImage> {
        // 重新绑定Pdfium库
        let library_path = if cfg!(target_os = "macos") {
            "sidecars/libpdfium.dylib-aarch64-apple-darwin"
        } else if cfg!(target_os = "windows") {
            "sidecars/pdfium.dll"
        } else {
            "sidecars/libpdfium.so"
        };

        let bindings = Pdfium::bind_to_library(library_path)
            .or_else(|_| Pdfium::bind_to_system_library())?;
        let pdfium = Pdfium::new(bindings);

        let doc = pdfium.load_pdf_from_byte_slice(&data_bytes, None)?;
        let (w_pt, h_pt) = page_dims;
        let scale = scale_x100 as f32 / 100.0;
        
        // 限制DPI范围以确保合理的性能和质量平衡
        let effective_dpi = (BASE_DPI * scale).max(MIN_DPI).min(MAX_DPI);
        let w_px = ((w_pt / 72.0) * effective_dpi).ceil() as u32;
        let h_px = ((h_pt / 72.0) * effective_dpi).ceil() as u32;

        println!(
            "📏 页面尺寸 - 原始:{}x{} pt, 缩放:{}, 有效DPI:{}, 目标:{}x{} px",
            w_pt, h_pt, scale, effective_dpi, w_px, h_px
        );

        let p = doc.pages().get(page as u16).map_err(|_| {
            anyhow!("页面超出范围: {}", page)
        })?;

        let cfg = PdfRenderConfig::new()
            .set_target_width(w_px as i32)
            .set_maximum_height(h_px as i32);

        let page_img = p.render_with_config(&cfg)?.as_image();
        Ok(page_img)
    }).await??;

    let t1 = Instant::now();
    println!("✅ 整页渲染完成，耗时: {:?}, 尺寸: {}x{}", 
             t1 - t0, page_img.width(), page_img.height());

    let result = Arc::new(page_img);
    PAGE_CACHE.lock().put(page_key, result.clone());
    
    Ok(result)
}

// 异步处理瓦片请求
async fn handle_tile_request(uri: &str, _app: &AppHandle) -> Result<Vec<u8>> {
    let request_start = Instant::now();
    println!("🔗 收到瓦片请求: {}", uri);
    
    let parts: Vec<&str> = uri.trim_matches('/').split('/').collect();
    println!("🔍 解析 URI 部分: {:?}", parts);
    
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
        _ => {
            eprintln!("❌ 无效的瓦片路径格式");
            return Err(anyhow!("bad tile path"));
        }
    };

    println!(
        "📊 瓦片参数 - ID:{}, 页面:{}, 比例:{}, 瓦片:({},{})",
        id, page, scale, tx, ty
    );

    let key = TileKey {
        id: id.clone(),
        page,
        scale_x100: (scale * 100.0).round() as u32,
        tx,
        ty,
    };

    // 1. 先检查瓦片缓存
    if let Some(buf) = TILE_CACHE.lock().get(&key) {
        let total_time = request_start.elapsed();
        println!("✅ 瓦片缓存命中，总耗时: {:?}", total_time);
        return Ok((**buf).clone());
    }

    // 2. 获取文档数据
    let data_arc = DOCS
        .lock()
        .get(&id)
        .ok_or_else(|| anyhow!("doc not found"))?
        .clone();

    // 3. 渲染瓦片
    let result = render_tile_directly(&data_arc, &key, request_start).await?;

    // 4. 缓存结果
    TILE_CACHE.lock().put(key, result.clone());
    
    let total_time = request_start.elapsed();
    println!("✅ 瓦片请求处理完成，总耗时: {:?}", total_time);
    
    Ok((*result).clone())
}

async fn render_tile_directly(data: &PdfData, key: &TileKey, request_start: Instant) -> Result<Arc<Vec<u8>>> {
    // 1. 获取整页图像（可能触发渲染或使用缓存）
    let page_img_arc = ensure_page_image(data, key.page, key.scale_x100).await?;
    let t1 = Instant::now();

    // 2. 在spawn_blocking中执行CPU密集型的裁剪和编码操作
    let key_clone = key.clone();
    let request_start_clone = request_start;
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Arc<Vec<u8>>> {
        let t1_inner = t1;
        
        // 裁剪瓦片
        let (w, h) = page_img_arc.dimensions();
        let scale = key_clone.scale_x100 as f32 / 100.0;
        
        // 检查是否为整页请求（特殊标记：tx=-1, ty=-1）
        if key_clone.tx == u32::MAX && key_clone.ty == u32::MAX {
            // 返回整页图像，不进行裁剪
            println!("📄 整页图像请求 - 页面:{}x{}, 缩放:{:.2}", w, h, scale);
            
            // 直接编码整页图像为WebP
            let rgba_img = page_img_arc.to_rgba8();
            let raw = rgba_img.into_raw();
            let webp = webp::Encoder::from_rgba(&raw, w, h).encode(WEBP_QUALITY as f32);
            let t3 = Instant::now();
            
            println!(
                "⏱️  整页图像性能 - page={} scale={:.2}: 整页渲染={:?} 编码={:?} 总计={:?}",
                key_clone.page, scale,
                t1_inner - request_start_clone, t3 - t1_inner, t3 - request_start_clone
            );
            
            return Ok(Arc::new(webp.to_vec()));
        }
        
        // 计算实际的瓦片大小和位置，考虑DPI缩放
        let effective_dpi = (BASE_DPI * scale).max(MIN_DPI).min(MAX_DPI);
        let dpi_scale = effective_dpi / BASE_DPI;
        let actual_tile_size = (TILE_SIZE as f32 * dpi_scale).round() as u32;
        let x = key_clone.tx * actual_tile_size;
        let y = key_clone.ty * actual_tile_size;

        println!(
            "📐 瓦片位置 - 页面:{}x{}, DPI缩放:{:.2}, 实际瓦片尺寸:{}, 瓦片起点:({},{})",
            w, h, dpi_scale, actual_tile_size, x, y
        );

        if x >= w || y >= h {
            return Err(anyhow!("tile out of bounds"));
        }

        let tw = actual_tile_size.min(w - x);
        let th = actual_tile_size.min(h - y);

        let sub_rgba: image::RgbaImage = crop_imm(&*page_img_arc, x, y, tw, th).to_image();
        let t2 = Instant::now();

        // 3. 编码为WebP
        let raw = sub_rgba.into_raw();
        let webp = webp::Encoder::from_rgba(&raw, tw, th).encode(WEBP_QUALITY as f32);
        let t3 = Instant::now();

        // 性能监控日志
        println!(
            "⏱️  性能统计 - page={} scale={:.2} tile=({},{}): 整页渲染={:?} 裁剪={:?} 编码={:?} 总计={:?}",
            key_clone.page, scale, key_clone.tx, key_clone.ty,
            t1_inner - request_start_clone, t2 - t1_inner, t3 - t2, t3 - request_start_clone
        );

        Ok(Arc::new(webp.to_vec()))
    }).await??;

    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_pdf, 
            get_page_text_layout, 
            extract_text_range
        ])
        .setup(|app| {
            use tauri::path::BaseDirectory;

            println!("🚀 开始初始化 Tauri 应用...");

            let rel_path = if cfg!(target_os = "macos") {
                "libpdfium.dylib"
            } else if cfg!(target_os = "windows") {
                "pdfium.dll"
            } else {
                "libpdfium.so"
            };

            println!("🔍 解析 Pdfium 库路径，相对路径: {}", rel_path);
            let lib_path = app
                .path()
                .resolve(rel_path, BaseDirectory::Resource)
                .unwrap_or_else(|e| {
                    eprintln!("⚠️ 无法解析资源路径: {}, 使用相对路径", e);
                    std::path::PathBuf::from(rel_path)
                });

            let library_path = lib_path.to_string_lossy().to_string();
            println!("📚 使用 Pdfium 库路径: {}", library_path);

            // 检查文件是否存在
            if std::path::Path::new(&library_path).exists() {
                println!("✅ Pdfium 库文件存在");
            } else {
                eprintln!("❌ Pdfium 库文件不存在: {}", library_path);
            }

            app.manage(PdfiumLibraryPath(library_path));
            println!("💾 PdfiumLibraryPath 状态已管理");

            println!("🎉 Tauri 应用初始化完成");
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("tiles", |ctx, request, responder| {
            use tauri::http::{header, Method, Response, StatusCode};
            
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            let origin = request.headers()
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
                        .unwrap()
                );
            }

            // 异步处理瓦片请求，利用thread_safe特性实现真正的并行处理
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
                    Err(e) => {
                        eprintln!("❌ 瓦片处理错误: {}", e);
                        Response::builder()
                            .status(StatusCode::NOT_FOUND)
                            .header(header::CONTENT_TYPE, "text/plain")
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, &origin)
                            .body(format!("tile error: {}", e).into_bytes())
                            .unwrap()
                    }
                };
                
                responder.respond(response);
            });
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
