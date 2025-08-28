// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use anyhow::{anyhow, Result};
use image::{imageops::crop_imm, GenericImageView};
use lru::LruCache;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use std::time::Instant;
use std::{collections::HashMap, num::NonZeroUsize, sync::Arc};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

// 优化瓦片尺寸和质量参数
const TILE_SIZE: u32 = 512;
const BASE_DPI: f32 = 150.0;
const WEBP_QUALITY: u8 = 70;
const MAX_DPI: f32 = 600.0;
const MIN_DPI: f32 = 36.0;

// 持久化的文档数据结构，存储字节数据和页面信息
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

// 修复页面图像缓存键，使用真实文档ID和整数缩放
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PageKey {
    id: String,
    page: u32,
    scale_x100: u32,
}

// 渲染请求跟踪，避免重复渲染
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RenderingKey {
    id: String,
    page: u32,
    scale_x100: u32,
}

static DOCS: Lazy<Mutex<HashMap<String, Arc<PdfData>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static TILE_CACHE: Lazy<Mutex<LruCache<TileKey, Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(NonZeroUsize::new(300).unwrap())));
static PAGE_CACHE: Lazy<Mutex<LruCache<PageKey, Arc<image::DynamicImage>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(NonZeroUsize::new(30).unwrap())));
// 正在渲染的页面跟踪，避免重复渲染
static RENDERING_PAGES: Lazy<Mutex<std::collections::HashSet<RenderingKey>>> =
    Lazy::new(|| Mutex::new(std::collections::HashSet::new()));

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
    pub idx: u32,   // 在该页文本流里的顺序索引
    pub ch: String, // 单字符（可能是空格/连字符等）
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

// 全局静态变量存储 Pdfium 库路径，供 spawn_blocking 中使用
static PDFIUM_LIBRARY_PATH: once_cell::sync::OnceCell<String> = once_cell::sync::OnceCell::new();

#[tauri::command]
async fn open_pdf(
    path: String,
    state: tauri::State<'_, PdfiumLibraryPath>,
) -> Result<crate::PdfMetadata, String> {
    let start_time = Instant::now();
    let library_path = state.0.clone();

    // 在 spawn_blocking 中执行文档加载和处理
    let (id, total_pages, page_dims, bytes) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(String, u32, Vec<(f32, f32)>, Vec<u8>), String> {
            let bindings = Pdfium::bind_to_library(&library_path)
                .or_else(|_| Pdfium::bind_to_system_library())
                .map_err(|e| format!("Failed to bind Pdfium library: {}", e))?;
            let pdfium = Pdfium::new(bindings);

            let doc = pdfium
                .load_pdf_from_file(&path, None)
                .map_err(|e| format!("PDF 文档加载失败: {}", e))?;

            let pages = doc.pages();
            let total_pages = pages.len() as u32;

            let page_dims: Vec<(f32, f32)> = pages
                .iter()
                .map(|p| (p.width().value, p.height().value))
                .collect();

            let id = Uuid::new_v4().to_string();

            // 读取文件字节数据用于缓存
            let bytes = std::fs::read(&path).map_err(|e| format!("文件读取失败: {}", e))?;

            Ok((id, total_pages, page_dims, bytes))
        },
    )
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // 存储持久化的文档数据
    let data = Arc::new(PdfData {
        bytes,
        page_dims: page_dims.clone(),
    });
    DOCS.lock().insert(id.clone(), data);

    let metadata = crate::PdfMetadata {
        id,
        total_pages,
        page_dims,
    };

    println!("✅ PDF 处理完成，耗时: {:?}", start_time.elapsed());
    Ok(metadata)
}

#[tauri::command]
async fn get_page_text_layout(id: String, page: u32) -> Result<PageTextLayout, String> {
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
        // 使用全局存储的 Pdfium 库路径
        let library_path = PDFIUM_LIBRARY_PATH
            .get()
            .ok_or_else(|| "Pdfium library path not initialized".to_string())?;

        let bindings = Pdfium::bind_to_library(library_path)
            .or_else(|_| Pdfium::bind_to_system_library())
            .map_err(|e| format!("Failed to bind Pdfium library: {}", e))?;
        let pdfium = Pdfium::new(bindings);

        let doc = pdfium
            .load_pdf_from_byte_slice(&data_bytes, None)
            .map_err(|e| format!("Failed to load PDF: {}", e))?;

        let pdf_page = doc
            .pages()
            .get(page as u16)
            .map_err(|e| format!("Page out of range: {}", e))?;

        let mut chars = Vec::new();

        // 使用 Pdfium 的文本提取功能
        if let Ok(text_page) = pdf_page.text() {
            let char_count = text_page.chars().len();
            chars.reserve(char_count);

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
        }

        Ok(PageTextLayout {
            width_pt: w_pt,
            height_pt: h_pt,
            chars,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    Ok(layout)
}

/// （可选）按字符区间提词（若想后端做规范化则可用）
#[tauri::command]
async fn extract_text_range(id: String, page: u32, start: u32, end: u32) -> Result<String, String> {
    // 获取文档数据
    let data_arc = DOCS
        .lock()
        .get(&id)
        .ok_or_else(|| "doc not found".to_string())?
        .clone();

    let data_bytes = data_arc.bytes.clone();

    // 在spawn_blocking中执行CPU密集型的Pdfium操作
    let text = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // 使用全局存储的 Pdfium 库路径
        let library_path = PDFIUM_LIBRARY_PATH
            .get()
            .ok_or_else(|| "Pdfium library path not initialized".to_string())?;

        let bindings = Pdfium::bind_to_library(library_path)
            .or_else(|_| Pdfium::bind_to_system_library())
            .map_err(|e| format!("Failed to bind Pdfium library: {}", e))?;
        let pdfium = Pdfium::new(bindings);

        let doc = pdfium
            .load_pdf_from_byte_slice(&data_bytes, None)
            .map_err(|e| format!("Failed to load PDF: {}", e))?;

        let pdf_page = doc
            .pages()
            .get(page as u16)
            .map_err(|e| format!("Page out of range: {}", e))?;

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
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    Ok(text)
}

// 直接渲染瓦片区域，使用整页渲染后裁剪的策略
async fn render_tile_direct(
    data: &PdfData,
    id: &str,
    page: u32,
    scale_x100: u32,
    tx: u32,
    ty: u32,
) -> Result<Arc<Vec<u8>>> {
    let start_time = std::time::Instant::now();
    // 检查是否为整页请求
    if tx == u32::MAX && ty == u32::MAX {
        // 使用整页渲染
        let page_img_arc = ensure_page_image(data, id, page, scale_x100).await?;

        let result = tauri::async_runtime::spawn_blocking(move || -> Result<Arc<Vec<u8>>> {
            // 编码整页图像为WebP
            let rgba_img = page_img_arc.to_rgba8();
            let raw = rgba_img.into_raw();
            let webp = webp::Encoder::from_rgba(&raw, page_img_arc.width(), page_img_arc.height())
                .encode(WEBP_QUALITY as f32);

            Ok(Arc::new(webp.to_vec()))
        })
        .await??;

        return Ok(result);
    }

    // 瓦片渲染 - 先获取整页图像，然后裁剪
    let page_img_arc = ensure_page_image(data, id, page, scale_x100).await?;

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Arc<Vec<u8>>> {
        let (w, h) = page_img_arc.dimensions();
        let scale = scale_x100 as f32 / 100.0;

        // 计算实际的瓦片大小和位置，考虑DPI缩放
        let effective_dpi = (BASE_DPI * scale).max(MIN_DPI).min(MAX_DPI);
        let dpi_scale = effective_dpi / BASE_DPI;
        let actual_tile_size = (TILE_SIZE as f32 * dpi_scale).round() as u32;
        let x = tx * actual_tile_size;
        let y = ty * actual_tile_size;

        if x >= w || y >= h {
            return Err(anyhow!("tile out of bounds"));
        }

        let tw = actual_tile_size.min(w - x);
        let th = actual_tile_size.min(h - y);

        let sub_rgba: image::RgbaImage = crop_imm(&*page_img_arc, x, y, tw, th).to_image();

        // 编码为WebP
        let raw = sub_rgba.into_raw();
        let webp = webp::Encoder::from_rgba(&raw, tw, th).encode(WEBP_QUALITY as f32);

        Ok(Arc::new(webp.to_vec()))
    })
    .await??;

    let elapsed = start_time.elapsed();
    println!(
        "📊 传统瓦片渲染 - 页面:{} 瓦片:{}x{} 缩放:{} 耗时:{:?}",
        page, tx, ty, scale_x100, elapsed
    );

    Ok(result)
}

// 新的原生瓦片直渲染函数：使用 FPDF_RenderPageBitmapWithMatrix 矩阵 + 裁剪
async fn render_tile_direct_native(
    data: &PdfData,
    _id: &str,
    page_index: u32,
    scale_x100: u32,
    tx: u32,
    ty: u32,
) -> Result<Arc<Vec<u8>>> {
    use std::cmp::min;

    // 整页请求：仍可走整页直出（很少用，保留分支）
    if tx == u32::MAX && ty == u32::MAX {
        return render_fullpage_direct_native(data, page_index, scale_x100).await;
    }

    let data_bytes = data.bytes.clone();
    let (w_pt, h_pt) = data.page_dims[page_index as usize];

    // 在阻塞线程里做 Pdfium 调用
    let start_time = std::time::Instant::now();
    let webp = tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<u8>, u32, u32)> {
        let step1_start = std::time::Instant::now();

        // 1) 绑定 & 打开文档 & 取页
        let lib_path = PDFIUM_LIBRARY_PATH
            .get()
            .ok_or_else(|| anyhow!("Pdfium path not set"))?;
        let bindings =
            Pdfium::bind_to_library(lib_path).or_else(|_| Pdfium::bind_to_system_library())?;
        let pdfium = Pdfium::new(bindings);

        let doc = pdfium.load_pdf_from_byte_slice(&data_bytes, None)?;
        let page = doc
            .pages()
            .get(page_index as u16)
            .map_err(|_| anyhow!("page out of range"))?;

        let step1_elapsed = step1_start.elapsed();
        println!("  📊 步骤1 - PDF加载: {:?}", step1_elapsed);

        let step2_start = std::time::Instant::now();

        // 2) 计算 DPI / 像素尺寸 / 瓦片在整页位图中的像素矩形
        let zoom = scale_x100 as f32 / 100.0;
        let effective_dpi = (BASE_DPI * zoom).clamp(MIN_DPI, MAX_DPI);
        let s = effective_dpi / 72.0; // pt->px

        let w_px = ((w_pt / 72.0) * effective_dpi).ceil() as u32;
        let h_px = ((h_pt / 72.0) * effective_dpi).ceil() as u32;

        let dpi_scale = effective_dpi / BASE_DPI;
        let actual_tile = (TILE_SIZE as f32 * dpi_scale).round() as u32;

        let x_px = tx.saturating_mul(actual_tile);
        let y_px = ty.saturating_mul(actual_tile);

        if x_px >= w_px || y_px >= h_px {
            return Err(anyhow!("tile out of bounds"));
        }

        let tw = min(actual_tile, w_px - x_px);
        let th = min(actual_tile, h_px - y_px);

        // 3) 计算 page-space 的瓦片矩形（单位 pt）
        // 1px 出血，避免瓦片缝
        let bleed_pt = 1.0 / s;

        // 瓦片的 page-space 边界（单位 pt）
        // 简化：直接模拟高级API的行为，不进行复杂的坐标转换
        let left_pt = (x_px as f32) / s - bleed_pt;
        let top_pt = (y_px as f32) / s - bleed_pt;
        let right_pt = ((x_px + tw) as f32) / s + bleed_pt;
        let bottom_pt = ((y_px + th) as f32) / s + bleed_pt;

        let step2_elapsed = step2_start.elapsed();
        println!("  📊 步骤2 - 坐标计算: {:?}", step2_elapsed);

        let step3_start = std::time::Instant::now();

        // 4) 创建 tw×th 目标位图（BGRA），并调用 FPDF_RenderPageBitmapWithMatrix
        let b = pdfium.bindings(); // 访问底层 FPDF_* 绑定
        unsafe {
            // 创建位图（带 Alpha）
            let bmp = b.FPDFBitmap_CreateEx(
                tw as i32,
                th as i32,
                4, // FPDFBitmap_BGRx/BGRA format
                std::ptr::null_mut(),
                0,
            );
            if bmp.is_null() {
                return Err(anyhow!("FPDFBitmap_CreateEx failed"));
            }

            // 取得底层页句柄
            let raw_page = b.get_handle_from_page(&page);

            // 获取页面旋转（0..3；分别表示 0/90/180/270 度）
            let rot: i32 = b.FPDFPage_GetRotation(raw_page) as i32;

            let step3_elapsed = step3_start.elapsed();
            println!("  📊 步骤3 - 位图创建: {:?}", step3_elapsed);

            println!(
                "🔍 调试信息 - 页面:{}x{} 像素:{}x{} 瓦片位置:({},{}) 瓦片尺寸:{}x{} 旋转:{}({}°)",
                w_pt,
                h_pt,
                w_px,
                h_px,
                x_px,
                y_px,
                tw,
                th,
                rot,
                rot * 90
            );
            println!(
                "🔍 PDF坐标 - left:{:.2} bottom:{:.2} top:{:.2}",
                left_pt, bottom_pt, top_pt
            );

            // —— 核心：针对 0/90/180/270 四种旋转给出"不会镜像"的矩阵 ——
            let s_f = s as f32;
            let tw_f = tw as f32;
            let th_f = th as f32;

            let mut m = match rot {
                // 旋转 0°：简化版本，模拟高级API的行为
                0 => pdfium_render::prelude::FS_MATRIX {
                    a: s_f,
                    b: 0.0,
                    c: 0.0,
                    d: s_f, // 不翻转Y轴
                    e: -s_f * left_pt,
                    f: -s_f * top_pt, // 简单的负值
                },
                // 旋转 90°（顺时针）：x' = s*(y - top) + tw,  y' = s*(x - left)
                1 => pdfium_render::prelude::FS_MATRIX {
                    a: 0.0,
                    b: s_f,
                    c: s_f,
                    d: 0.0,
                    e: -s_f * top_pt + tw_f,
                    f: -s_f * left_pt,
                },
                // 旋转 180°：x' = -s*(x - left) + tw,  y' =  s*(y - top) + th
                2 => pdfium_render::prelude::FS_MATRIX {
                    a: -s_f,
                    b: 0.0,
                    c: 0.0,
                    d: s_f,
                    e: s_f * left_pt + tw_f,
                    f: -s_f * top_pt + th_f,
                },
                // 旋转 270°：x' = -s*(y - top),  y' = -s*(x - left) + th
                3 => pdfium_render::prelude::FS_MATRIX {
                    a: 0.0,
                    b: -s_f,
                    c: -s_f,
                    d: 0.0,
                    e: s_f * top_pt,
                    f: s_f * left_pt + th_f,
                },
                _ => pdfium_render::prelude::FS_MATRIX {
                    // 兜底，当成 0°
                    a: s_f,
                    b: 0.0,
                    c: 0.0,
                    d: -s_f,
                    e: -s_f * left_pt,
                    f: s_f * top_pt,
                },
            };

            // 设备裁剪矩形就是瓦片位图范围
            let clip = pdfium_render::prelude::FS_RECTF {
                left: 0.0,
                top: 0.0,
                right: tw as f32,
                bottom: th as f32,
            };

            // 屏显建议：锐文本 + 批注
            let flags: i32 = 0x01 /*FPDF_LCD_TEXT*/ | 0x02 /*FPDF_ANNOT*/;

            let step4_start = std::time::Instant::now();
            b.FPDFBitmap_FillRect(bmp, 0, 0, tw as i32, th as i32, 0x00000000);
            b.FPDF_RenderPageBitmapWithMatrix(bmp, raw_page, &mut m, &clip, flags);
            let step4_elapsed = step4_start.elapsed();
            println!("  📊 步骤4 - PDF渲染: {:?}", step4_elapsed);

            let step5_start = std::time::Instant::now();

            // 取像素缓冲 & stride，转成 RGBA（从 BGRA 到 RGBA）
            let buf = b.FPDFBitmap_GetBuffer(bmp) as *const u8;
            let stride = b.FPDFBitmap_GetStride(bmp) as usize;
            let src = std::slice::from_raw_parts(buf, stride * (th as usize));

            // 将可能带对齐的行，拷成紧凑 RGBA
            let mut rgba = Vec::with_capacity((tw * th * 4) as usize);
            for row in 0..(th as usize) {
                let start = row * stride;
                let row_bytes = &src[start..start + (tw as usize) * 4];
                // BGRA -> RGBA
                for px in row_bytes.chunks_exact(4) {
                    rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
                }
            }

            // 销毁位图
            b.FPDFBitmap_Destroy(bmp);

            let step5_elapsed = step5_start.elapsed();
            println!("  📊 步骤5 - 像素转换: {:?}", step5_elapsed);

            let step6_start = std::time::Instant::now();
            // 5) WebP 编码（与现有一致）
            let webp = webp::Encoder::from_rgba(&rgba, tw, th).encode(WEBP_QUALITY as f32);
            let step6_elapsed = step6_start.elapsed();
            println!("  📊 步骤6 - WebP编码: {:?}", step6_elapsed);

            Ok((webp.to_vec(), tw, th))
        }
    })
    .await??;

    let elapsed = start_time.elapsed();
    println!(
        "🚀 原生瓦片渲染 - 页面:{} 瓦片:{}x{} 缩放:{} 尺寸:{}x{} 耗时:{:?}",
        page_index, tx, ty, scale_x100, webp.1, webp.2, elapsed
    );

    Ok(Arc::new(webp.0))
}

// 整页直出（若需要 tiles/-1_-1 的整页下载）
async fn render_fullpage_direct_native(
    data: &PdfData,
    page_index: u32,
    scale_x100: u32,
) -> Result<Arc<Vec<u8>>> {
    let data_bytes = data.bytes.clone();
    let (w_pt, h_pt) = data.page_dims[page_index as usize];

    let webp = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>> {
        let lib_path = PDFIUM_LIBRARY_PATH
            .get()
            .ok_or_else(|| anyhow!("Pdfium path not set"))?;
        let bindings =
            Pdfium::bind_to_library(lib_path).or_else(|_| Pdfium::bind_to_system_library())?;
        let pdfium = Pdfium::new(bindings);

        let doc = pdfium.load_pdf_from_byte_slice(&data_bytes, None)?;
        let page = doc
            .pages()
            .get(page_index as u16)
            .map_err(|_| anyhow!("page out of range"))?;

        let scale = scale_x100 as f32 / 100.0;
        let effective_dpi = (BASE_DPI * scale).clamp(MIN_DPI, MAX_DPI);
        let s = effective_dpi / 72.0;

        let w_px = ((w_pt / 72.0) * effective_dpi).ceil() as u32;
        let h_px = ((h_pt / 72.0) * effective_dpi).ceil() as u32;

        let b = pdfium.bindings();
        unsafe {
            let bmp = b.FPDFBitmap_CreateEx(w_px as i32, h_px as i32, 4, std::ptr::null_mut(), 0);
            if bmp.is_null() {
                return Err(anyhow!("FPDFBitmap_CreateEx failed"));
            }

            b.FPDFBitmap_FillRect(bmp, 0, 0, w_px as i32, h_px as i32, 0x00FFFFFF);

            // 整页矩阵：简化版本，与瓦片渲染保持一致
            let mut m = pdfium_render::prelude::FS_MATRIX {
                a: s,
                b: 0.0,
                c: 0.0,
                d: s, // 不翻转Y轴，与瓦片渲染保持一致
                e: 0.0,
                f: 0.0, // 简化偏移
            };
            let clip = pdfium_render::prelude::FS_RECTF {
                left: 0.0,
                top: 0.0,
                right: w_px as f32,
                bottom: h_px as f32,
            };

            let raw_page = b.get_handle_from_page(&page);
            b.FPDF_RenderPageBitmapWithMatrix(bmp, raw_page, &mut m, &clip, 0);

            let buf = b.FPDFBitmap_GetBuffer(bmp) as *const u8;
            let stride = b.FPDFBitmap_GetStride(bmp) as usize;
            let src = std::slice::from_raw_parts(buf, stride * (h_px as usize));

            let mut rgba = Vec::with_capacity((w_px * h_px * 4) as usize);
            for row in 0..(h_px as usize) {
                let start = row * stride;
                let row_bytes = &src[start..start + (w_px as usize) * 4];
                for px in row_bytes.chunks_exact(4) {
                    rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
                }
            }

            b.FPDFBitmap_Destroy(bmp);

            let webp = webp::Encoder::from_rgba(&rgba, w_px, h_px).encode(WEBP_QUALITY as f32);
            Ok(webp.to_vec())
        }
    })
    .await??;

    Ok(Arc::new(webp))
}

// 获取或创建页面图像（修复缓存键问题）
async fn ensure_page_image(
    data: &PdfData,
    id: &str,
    page: u32,
    scale_x100: u32,
) -> Result<Arc<image::DynamicImage>> {
    let page_key = PageKey {
        id: id.to_string(),
        page,
        scale_x100,
    };

    let rendering_key = RenderingKey {
        id: id.to_string(),
        page,
        scale_x100,
    };

    // 检查页面缓存
    if let Some(cached_img) = PAGE_CACHE.lock().get(&page_key) {
        return Ok(cached_img.clone());
    }

    // 检查是否正在渲染，避免重复渲染
    {
        let mut rendering = RENDERING_PAGES.lock();
        if rendering.contains(&rendering_key) {
            // 等待一段时间后重试缓存
            drop(rendering);
            std::thread::sleep(std::time::Duration::from_millis(10));
            if let Some(cached_img) = PAGE_CACHE.lock().get(&page_key) {
                return Ok(cached_img.clone());
            }
        } else {
            rendering.insert(rendering_key.clone());
        }
    }

    let data_bytes = data.bytes.clone();
    let page_dims = data.page_dims[page as usize];

    // 在spawn_blocking中执行CPU密集型的Pdfium操作
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<image::DynamicImage> {
        // 使用全局存储的 Pdfium 库路径
        let library_path = PDFIUM_LIBRARY_PATH
            .get()
            .ok_or_else(|| anyhow!("Pdfium library path not initialized"))?;

        let bindings =
            Pdfium::bind_to_library(library_path).or_else(|_| Pdfium::bind_to_system_library())?;
        let pdfium = Pdfium::new(bindings);

        let doc = pdfium.load_pdf_from_byte_slice(&data_bytes, None)?;
        let (w_pt, h_pt) = page_dims;
        let scale = scale_x100 as f32 / 100.0;

        // 限制DPI范围以确保合理的性能和质量平衡
        let effective_dpi = (BASE_DPI * scale).max(MIN_DPI).min(MAX_DPI);
        let w_px = ((w_pt / 72.0) * effective_dpi).ceil() as u32;
        let h_px = ((h_pt / 72.0) * effective_dpi).ceil() as u32;

        let pdf_page = doc
            .pages()
            .get(page as u16)
            .map_err(|_| anyhow!("页面超出范围: {}", page))?;

        let cfg = PdfRenderConfig::new()
            .set_target_width(w_px as i32)
            .set_maximum_height(h_px as i32);

        let page_img = pdf_page.render_with_config(&cfg)?.as_image();
        Ok(page_img)
    })
    .await??;

    let result_arc = Arc::new(result);
    PAGE_CACHE.lock().put(page_key, result_arc.clone());

    // 移除渲染标记
    RENDERING_PAGES.lock().remove(&rendering_key);

    Ok(result_arc)
}

// 异步处理瓦片请求
async fn handle_tile_request(uri: &str, _app: &AppHandle) -> Result<Vec<u8>> {
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
    if let Some(buf) = TILE_CACHE.lock().get(&key) {
        return Ok((**buf).clone());
    }

    // 获取文档数据
    let data_arc = DOCS
        .lock()
        .get(&id)
        .ok_or_else(|| anyhow!("doc not found"))?
        .clone();

    // 测试简化版本的新方法
    // let result = render_tile_direct(&data_arc, &id, page, scale_x100, tx, ty).await?; // 旧方法：整页渲染后裁剪
    let result = render_tile_direct_native(&data_arc, &id, page, scale_x100, tx, ty).await?; // 新方法：简化版本

    // 缓存结果
    TILE_CACHE.lock().put(key, result.clone());

    Ok((*result).clone())
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
            extract_text_range
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

            app.manage(PdfiumLibraryPath(library_path));
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
