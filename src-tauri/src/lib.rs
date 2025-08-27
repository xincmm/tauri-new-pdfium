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
use webp::Encoder as WebpEncoder2;

const TILE_SIZE: u32 = 512;
const BASE_DPI: f32 = 144.0;
const WEBP_QUALITY: u8 = 80;

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

static DOCS: Lazy<Mutex<HashMap<String, Arc<PdfData>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static TILE_CACHE: Lazy<Mutex<LruCache<TileKey, Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(NonZeroUsize::new(200).unwrap())));

#[derive(Serialize, Deserialize, Debug)]
pub struct PdfMetadata {
    id: String,
    total_pages: u32,
    page_dims: Vec<(f32, f32)>,
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

fn handle_tile_request(uri: &str, _app: &AppHandle) -> Result<Vec<u8>> {
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

    // 1. 先检查最终的瓦片缓存
    println!("🔍 检查瓦片缓存...");
    if let Some(buf) = TILE_CACHE.lock().get(&key) {
        println!("✅ 瓦片缓存命中，直接返回");
        return Ok((**buf).clone());
    }
    println!("❌ 瓦片缓存未命中");

    // 2. 从文档缓存获取 PDF 字节数据
    println!("🔍 查找文档数据...");
    let data_arc = DOCS
        .lock()
        .get(&id)
        .ok_or_else(|| {
            eprintln!("❌ 文档未找到: {}", id);
            anyhow!("doc not found")
        })?
        .clone();
    println!("✅ 文档数据找到");

    // 3. 直接渲染瓦片（不使用 Actor）
    println!("🎨 开始渲染瓦片...");
    let result = render_tile_directly(&data_arc, &key)?;

    // 4. 将结果存入缓存
    println!("💾 将结果存入瓦片缓存...");
    TILE_CACHE.lock().put(key, result.clone());
    println!("✅ 瓦片请求处理完成，返回结果");
    Ok((*result).clone())
}

fn render_tile_directly(data: &PdfData, key: &TileKey) -> Result<Arc<Vec<u8>>> {
    println!("🔗 直接渲染：绑定 Pdfium 库...");

    // 每次都重新绑定，避免状态问题
    let library_path = if cfg!(target_os = "macos") {
        "sidecars/libpdfium.dylib-aarch64-apple-darwin"
    } else if cfg!(target_os = "windows") {
        "sidecars/pdfium.dll"
    } else {
        "sidecars/libpdfium.so"
    };

    let bindings =
        Pdfium::bind_to_library(library_path).or_else(|_| Pdfium::bind_to_system_library())?;
    let pdfium = Pdfium::new(bindings);

    println!("📄 直接渲染：加载 PDF 文档...");
    let doc = pdfium.load_pdf_from_byte_slice(&data.bytes, None)?;

    let (w_pt, h_pt) = data.page_dims[key.page as usize];
    let scale = key.scale_x100 as f32 / 100.0;
    let w_px = ((w_pt / 72.0) * BASE_DPI * scale).ceil() as u32;
    let h_px = ((h_pt / 72.0) * BASE_DPI * scale).ceil() as u32;

    println!(
        "📏 页面尺寸 - 原始:{}x{} pt, 缩放:{}, 目标:{}x{} px",
        w_pt, h_pt, scale, w_px, h_px
    );

    println!("📖 获取页面 {}...", key.page);
    let p = doc.pages().get(key.page as u16).map_err(|_| {
        eprintln!("❌ 页面超出范围: {}", key.page);
        anyhow!("page out of range")
    })?;

    println!("⚙️ 配置渲染参数...");
    let cfg = PdfRenderConfig::new()
        .set_target_width(w_px as i32)
        .set_maximum_height(h_px as i32);

    println!("🖼️ 渲染页面图像...");
    let page_img = p.render_with_config(&cfg)?.as_image();

    println!("✂️ 开始裁剪瓦片...");
    let (w, h) = page_img.dimensions();
    let x = key.tx * TILE_SIZE;
    let y = key.ty * TILE_SIZE;

    println!("📐 瓦片位置 - 页面:{}x{}, 瓦片起点:({},{})", w, h, x, y);

    if x >= w || y >= h {
        eprintln!(
            "❌ 瓦片超出边界: 瓦片起点({},{}) >= 页面尺寸({}x{})",
            x, y, w, h
        );
        return Err(anyhow!("tile out of bounds"));
    }

    let tw = TILE_SIZE.min(w - x);
    let th = TILE_SIZE.min(h - y);
    println!("📏 瓦片尺寸: {}x{}", tw, th);

    println!("✂️ 裁剪图像区域...");
    let sub_rgba: image::RgbaImage = crop_imm(&page_img, x, y, tw, th).to_image();
    let raw = sub_rgba.into_raw();

    println!("🗜️ 编码为 WebP 格式...");
    let webp = WebpEncoder2::from_rgba(&raw, tw, th).encode(WEBP_QUALITY as f32);

    println!("✅ 瓦片渲染完成，大小: {} bytes", webp.len());
    Ok(Arc::new(webp.to_vec()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_pdf])
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
        .register_uri_scheme_protocol("tiles", move |ctx, request| {
            let app = ctx.app_handle();
            let uri = request.uri();
            let path = uri.path().to_string();

            println!("🔗 URI 协议处理器被调用: {}", uri);
            println!("🔍 请求路径: {}", path);

            match handle_tile_request(&path, &app) {
                Ok(bytes) => tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::OK)
                    .header(tauri::http::header::CONTENT_TYPE, "image/webp")
                    .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(
                        tauri::http::header::ACCESS_CONTROL_ALLOW_METHODS,
                        "GET, POST, OPTIONS",
                    )
                    .header(tauri::http::header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
                    .header(
                        tauri::http::header::CACHE_CONTROL,
                        "public, max-age=31536000",
                    )
                    .body(bytes)
                    .unwrap(),
                Err(e) => {
                    eprintln!("tile error: {e}");
                    tauri::http::Response::builder()
                        .status(tauri::http::StatusCode::NOT_FOUND)
                        .header(tauri::http::header::CONTENT_TYPE, "text/plain")
                        .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(format!("tile error: {e}").into_bytes())
                        .unwrap()
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
