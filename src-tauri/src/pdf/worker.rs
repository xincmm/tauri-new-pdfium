use crate::pdf::types::*;
use uuid::Uuid;
use anyhow::Result;
use crossbeam_channel::{unbounded, Receiver, Sender};
use pdfium_render::prelude::*;
use rayon::prelude::*;
use std::collections::HashMap;
use std::time::Instant;

// 瓦片请求数据结构
#[derive(serde::Deserialize, Debug)]
pub struct TileRequest {
    pub page_index: u16,
    pub rect_x: f32,
    pub rect_y: f32, 
    pub rect_width: f32,
    pub rect_height: f32,
    pub scale_factor: f32,
    pub dpr: f32,
}

// 瓦片渲染结果
#[derive(Debug, Clone)]
pub struct TileRenderResult {
    pub data: Vec<u8>,
    pub setup_ms: f64,
    pub raster_ms: f64,
    pub pack_ms: f64,
    pub encode_ms: f64,
    pub total_ms: f64,
    pub pixel_width: i32,
    pub pixel_height: i32,
}

// PDF工作线程的命令
pub enum PdfCommand {
    LoadDocument {
        file_path: String,
        resp: Sender<Result<PdfDocumentMetadata, String>>,
    },
    RenderTilesBatch {
        requests: Vec<TileRequest>,
        resp: Sender<Result<Vec<TileRenderResult>, String>>,
    },
    Shutdown,
}

// 文档条目，长期驻留在工作线程中
struct DocumentEntry {
    bytes: Vec<u8>,
    doc: FPDF_DOCUMENT,
    page_dims: Vec<(f32, f32)>,
    pages: HashMap<u32, FPDF_PAGE>,
}

impl DocumentEntry {
    fn cleanup(&mut self, bindings: &dyn PdfiumLibraryBindings) {
        unsafe {
            // 释放所有页句柄
            for (_, page_handle) in self.pages.drain() {
                bindings.FPDF_ClosePage(page_handle);
            }
            // 释放文档句柄
            bindings.FPDF_CloseDocument(self.doc);
        }
    }

    fn get_or_load_page(
        &mut self,
        page: u32,
        bindings: &dyn PdfiumLibraryBindings,
    ) -> Option<FPDF_PAGE> {
        if let Some(&page_handle) = self.pages.get(&page) {
            return Some(page_handle);
        }
        
        unsafe {
            let page_handle = bindings.FPDF_LoadPage(self.doc, page as i32);
            if !page_handle.is_null() {
                self.pages.insert(page, page_handle);
                Some(page_handle)
            } else {
                None
            }
        }
    }
}

// PDF工作线程
pub struct PdfWorker {
    pdfium: Pdfium,
    document: Option<DocumentEntry>,
    rx: Receiver<PdfCommand>,
}

impl PdfWorker {
    pub fn new(library_path: String, rx: Receiver<PdfCommand>) -> Result<Self, String> {
        let bindings = Pdfium::bind_to_library(&library_path)
            .or_else(|_| Pdfium::bind_to_system_library())
            .map_err(|e| format!("Failed to bind Pdfium library: {}", e))?;
        
        let pdfium = Pdfium::new(bindings);
        println!("🔧 PDF工作线程启动，Pdfium库路径: {}", library_path);
        
        Ok(Self {
            pdfium,
            document: None,
            rx,
        })
    }

    pub fn run(&mut self) {
        println!("🚀 PDF工作线程开始运行");
        
        while let Ok(cmd) = self.rx.recv() {
            match cmd {
                PdfCommand::LoadDocument { file_path, resp } => {
                    let result = self.handle_load_document(file_path);
                    let _ = resp.send(result);
                }
                PdfCommand::RenderTilesBatch { requests, resp } => {
                    let result = self.handle_render_tiles_batch(requests);
                    let _ = resp.send(result);
                }
                PdfCommand::Shutdown => {
                    println!("📴 PDF工作线程收到关闭信号");
                    self.cleanup();
                    break;
                }
            }
        }
        
        println!("🛑 PDF工作线程已停止");
    }

    fn handle_load_document(&mut self, file_path: String) -> Result<PdfDocumentMetadata, String> {
        let start_time = Instant::now();
        
        // 读取文件
        let bytes = std::fs::read(&file_path)
            .map_err(|e| format!("文件读取失败: {}", e))?;

                let bindings = self.pdfium.bindings();
        unsafe {
            // 清理现有文档
            if let Some(mut old_doc) = self.document.take() {
                old_doc.cleanup(bindings);
            }
            
            // 加载新文档
            let doc = bindings.FPDF_LoadMemDocument64(&bytes, None);
            if doc.is_null() {
                return Err("FPDF_LoadMemDocument64 failed".to_string());
            }
            
            let page_count = bindings.FPDF_GetPageCount(doc) as u32;
            let mut page_dims = Vec::with_capacity(page_count as usize);
            
            for i in 0..page_count {
                let mut size = FS_SIZEF { width: 0.0, height: 0.0 };
                bindings.FPDF_GetPageSizeByIndexF(doc, i as i32, &mut size);
                page_dims.push((size.width, size.height));
            }
            
            self.document = Some(DocumentEntry {
                bytes,
                doc,
                page_dims: page_dims.clone(),
                pages: HashMap::new(),
            });
            
            // 生成文档ID
            let doc_id = Uuid::new_v4().to_string();
            
            let metadata = PdfDocumentMetadata {
                id: doc_id.clone(),
                total_pages: page_count,
                page_dims: page_dims.clone(),
            };
            
            println!(
                "✅ PDF文档加载完成，耗时: {:?}, 页数: {}, ID: {}",
                start_time.elapsed(),
                page_count,
                doc_id
            );
            println!("📏 页面尺寸: {:?}", page_dims);
            
            Ok(metadata)
        }
    }

    fn handle_render_tiles_batch(&mut self, requests: Vec<TileRequest>) -> Result<Vec<TileRenderResult>, String> {
        let batch_start = Instant::now();
        
        let document = self.document.as_mut()
            .ok_or("No document loaded")?;
        
        println!("开始批量渲染 {} 个瓦片", requests.len());
        
        // 1. 串行渲染阶段 - 生成所有瓦片的原始数据
        let bindings = self.pdfium.bindings();
        let mut tiles_data = Vec::new();
        for (idx, req) in requests.iter().enumerate() {
            if let Some(tile_data) = Self::render_single_tile(bindings, document, req, idx) {
                tiles_data.push(tile_data);
            }
        }
        
        let rendering_done = Instant::now();
        println!("--- 串行渲染完成: {} 个瓦片，耗时: {:?} ---", 
                tiles_data.len(), rendering_done - batch_start);
        
        // 2. 并行编码阶段 - 使用rayon并行编码
        let encoded_results: Vec<TileRenderResult> = tiles_data
            .into_par_iter()
            .map(|(rgba_data, width, height, setup_ms, raster_ms, pack_ms)| {
                let encode_start = Instant::now();
                
                // 使用webp编码
                let webp_data = webp::Encoder::from_rgba(&rgba_data, width as u32, height as u32).encode(80.0);
                let encode_ms = encode_start.elapsed().as_secs_f64() * 1000.0;
                let total_ms = setup_ms + raster_ms + pack_ms + encode_ms;
                
                println!("瓦片编码完成: {}x{} in {:.2}ms", width, height, encode_ms);
                
                TileRenderResult {
                    data: webp_data.to_vec(),
                    setup_ms,
                    raster_ms,
                    pack_ms,
                    encode_ms,
                    total_ms,
                    pixel_width: width,
                    pixel_height: height,
                }
            })
            .collect();
        
        let encoding_done = Instant::now();
        println!("--- 并行编码完成: 耗时: {:?} ---", encoding_done - rendering_done);
        println!("--- 总耗时: {:?} ---", batch_start.elapsed());
        
        Ok(encoded_results)
    }
    
    fn render_single_tile(
        pdfium_bindings: &dyn PdfiumLibraryBindings,
        document: &mut DocumentEntry, 
        req: &TileRequest, 
        idx: usize
    ) -> Option<(Vec<u8>, i32, i32, f64, f64, f64)> {
        
        let tile_start = Instant::now();
        
        // 0. 设置阶段
        let setup_start = Instant::now();
        
        let page_handle = document.get_or_load_page(req.page_index as u32, pdfium_bindings)?;
        
        // 计算像素尺寸
        // PDF坐标为 points（72dpi），屏幕像素以 96dpi 计；需要乘以 96/72 才能得到像素尺寸
        let px_per_point: f32 = 96.0f32 / 72.0f32;
        let target_width = (req.rect_width * req.scale_factor * req.dpr * px_per_point).round() as i32;
        let target_height = (req.rect_height * req.scale_factor * req.dpr * px_per_point).round() as i32;
        
        unsafe {
            // 创建位图
            let bitmap = pdfium_bindings.FPDFBitmap_CreateEx(
                target_width, target_height, 4, std::ptr::null_mut(), 0
            );
            if bitmap.is_null() {
                eprintln!("FPDFBitmap_CreateEx failed for tile {}", idx);
                return None;
            }
            
            // 填充白色背景
            pdfium_bindings.FPDFBitmap_FillRect(bitmap, 0, 0, target_width, target_height, 0xFFFFFFFF);
            let setup_ms = setup_start.elapsed().as_secs_f64() * 1000.0;
            
            // 1. 光栅化阶段
            let raster_start = Instant::now();
            
            // 计算渲染矩阵以实现区域裁剪
            // 将 points → pixels 的换算一并纳入矩阵缩放
            let scale = req.scale_factor * req.dpr * px_per_point;
            
            // 渲染矩阵：缩放并平移到指定区域
            let mut matrix = FS_MATRIX {
                a: scale,  // x缩放
                b: 0.0,
                c: 0.0, 
                d: scale,  // y缩放
                e: -req.rect_x * scale,  // x平移（负值向左移）
                f: -req.rect_y * scale,  // y平移（负值向上移）
            };
            
            // 裁剪矩形
            let clip = FS_RECTF {
                left: 0.0,
                top: 0.0,
                right: target_width as f32,
                bottom: target_height as f32,
            };
            
            println!("瓦片 {} 渲染参数: 区域=({:.1},{:.1},{:.1},{:.1}), 缩放={:.1}, 目标={}x{}", 
                idx, req.rect_x, req.rect_y, req.rect_width, req.rect_height, scale, target_width, target_height);
            
            // 使用矩阵渲染指定区域
            pdfium_bindings.FPDF_RenderPageBitmapWithMatrix(
                bitmap,
                page_handle,
                &mut matrix,
                &clip,
                0x01 | 0x02, // FPDF_LCD_TEXT | FPDF_ANNOT
            );
            
            let raster_ms = raster_start.elapsed().as_secs_f64() * 1000.0;
            
            // 2. 打包阶段 - 转换颜色格式
            let pack_start = Instant::now();
            
            let buffer = pdfium_bindings.FPDFBitmap_GetBuffer(bitmap) as *const u8;
            let stride = pdfium_bindings.FPDFBitmap_GetStride(bitmap) as usize;
            let src_data = std::slice::from_raw_parts(
                buffer, 
                stride * target_height as usize
            );
            
            // 转换 BGRA -> RGBA
            let mut rgba_data = Vec::with_capacity((target_width * target_height * 4) as usize);
            for row in 0..target_height {
                let row_start = (row as usize) * stride;
                let row_data = &src_data[row_start..row_start + (target_width as usize * 4)];
                
                for pixel in row_data.chunks_exact(4) {
                    rgba_data.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
                }
            }
            
            pdfium_bindings.FPDFBitmap_Destroy(bitmap);
            let pack_ms = pack_start.elapsed().as_secs_f64() * 1000.0;
            
            let total_render_ms = tile_start.elapsed().as_secs_f64() * 1000.0;
            println!(
                "瓦片 {} 渲染完成: {}x{} in {:.2}ms (设置:{:.2}ms + 光栅:{:.2}ms + 打包:{:.2}ms)",
                idx, target_width, target_height, total_render_ms, setup_ms, raster_ms, pack_ms
            );
            
            Some((rgba_data, target_width, target_height, setup_ms, raster_ms, pack_ms))
        }
    }

    fn cleanup(&mut self) {
        if let Some(mut document) = self.document.take() {
            let bindings = self.pdfium.bindings();
            document.cleanup(bindings);
            println!("🗑️ 文档资源已清理");
        }
    }
}

// PDF工作线程句柄
#[derive(Clone)]
pub struct PdfWorkerHandle {
    tx: Sender<PdfCommand>,
}

impl PdfWorkerHandle {
    pub fn load_document(&self, file_path: String) -> Result<PdfDocumentMetadata, String> {
        let (resp_tx, resp_rx) = crossbeam_channel::bounded(1);
        self.tx.send(PdfCommand::LoadDocument { file_path, resp: resp_tx })
            .map_err(|e| format!("Failed to send command: {}", e))?;
        resp_rx.recv()
            .map_err(|e| format!("Failed to receive response: {}", e))?
    }

    pub fn render_tiles_batch(&self, requests: Vec<TileRequest>) -> Result<Vec<TileRenderResult>, String> {
        let (resp_tx, resp_rx) = crossbeam_channel::bounded(1);
        self.tx.send(PdfCommand::RenderTilesBatch { requests, resp: resp_tx })
            .map_err(|e| format!("Failed to send command: {}", e))?;
        resp_rx.recv()
            .map_err(|e| format!("Failed to receive response: {}", e))?
    }
}

// 启动PDF工作线程
pub fn spawn_pdf_worker(library_path: String) -> Result<PdfWorkerHandle, String> {
    let (tx, rx) = unbounded::<PdfCommand>();
    
    std::thread::spawn(move || {
        match PdfWorker::new(library_path, rx) {
            Ok(mut worker) => {
                worker.run();
            }
            Err(e) => {
                eprintln!("❌ PDF工作线程启动失败: {}", e);
            }
        }
    });
    
    Ok(PdfWorkerHandle { tx })
}
