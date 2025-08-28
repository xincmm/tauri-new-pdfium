use crate::pdf::types::{self, *};
use anyhow::{anyhow, Result};
use crossbeam_channel::{unbounded, Receiver, Sender};
use pdfium_render::prelude::*;
use std::collections::HashMap;
use std::time::Instant;
use uuid::Uuid;

// PDF工作线程的消息定义
pub enum PdfCmd {
    Open {
        id: String,
        bytes: Vec<u8>,
        resp: Sender<Result<types::PdfMetadata>>,
    },
    RenderTile {
        id: String,
        page: u32,
        scale_x100: u32,
        tx_idx: u32,
        ty_idx: u32,
        resp: Sender<Result<Vec<u8>>>,
    },
    TextLayout {
        id: String,
        page: u32,
        resp: Sender<Result<PageTextLayout>>,
    },
    ExtractRange {
        id: String,
        page: u32,
        start: u32,
        end: u32,
        resp: Sender<Result<String>>,
    },
    Close {
        id: String,
    },
    Shutdown,
}

// PDF工作线程的句柄，用于发送消息
#[derive(Clone)]
pub struct PdfWorkerHandle {
    pub tx: Sender<PdfCmd>,
}

impl PdfWorkerHandle {
    pub fn send_cmd(&self, cmd: PdfCmd) -> Result<()> {
        self.tx
            .send(cmd)
            .map_err(|e| anyhow!("Failed to send command: {}", e))
    }

    pub fn open_document(&self, bytes: Vec<u8>) -> Result<types::PdfMetadata> {
        let id = Uuid::new_v4().to_string();
        let (resp_tx, resp_rx) = crossbeam_channel::bounded(1);

        self.send_cmd(PdfCmd::Open {
            id: id.clone(),
            bytes,
            resp: resp_tx,
        })?;

        resp_rx
            .recv()
            .map_err(|e| anyhow!("Failed to receive response: {}", e))?
    }

    pub fn render_tile(
        &self,
        id: String,
        page: u32,
        scale_x100: u32,
        tx_idx: u32,
        ty_idx: u32,
    ) -> Result<Vec<u8>> {
        let (resp_tx, resp_rx) = crossbeam_channel::bounded(1);

        self.send_cmd(PdfCmd::RenderTile {
            id,
            page,
            scale_x100,
            tx_idx,
            ty_idx,
            resp: resp_tx,
        })?;

        resp_rx
            .recv()
            .map_err(|e| anyhow!("Failed to receive response: {}", e))?
    }

    pub fn get_text_layout(&self, id: String, page: u32) -> Result<PageTextLayout> {
        let (resp_tx, resp_rx) = crossbeam_channel::bounded(1);

        self.send_cmd(PdfCmd::TextLayout {
            id,
            page,
            resp: resp_tx,
        })?;

        resp_rx
            .recv()
            .map_err(|e| anyhow!("Failed to receive response: {}", e))?
    }

    pub fn extract_text_range(
        &self,
        id: String,
        page: u32,
        start: u32,
        end: u32,
    ) -> Result<String> {
        let (resp_tx, resp_rx) = crossbeam_channel::bounded(1);

        self.send_cmd(PdfCmd::ExtractRange {
            id,
            page,
            start,
            end,
            resp: resp_tx,
        })?;

        resp_rx
            .recv()
            .map_err(|e| anyhow!("Failed to receive response: {}", e))?
    }

    pub fn close_document(&self, id: String) -> Result<()> {
        self.send_cmd(PdfCmd::Close { id })
    }

    pub fn shutdown(&self) -> Result<()> {
        self.send_cmd(PdfCmd::Shutdown)
    }
}

// PDF工作线程
pub struct PdfWorker {
    pdfium: Pdfium,
    docs: HashMap<String, DocEntry>,
    rx: Receiver<PdfCmd>,
}

impl PdfWorker {
    pub fn new(library_path: String, rx: Receiver<PdfCmd>) -> Result<Self> {
        let bindings = Pdfium::bind_to_library(&library_path)
            .or_else(|_| Pdfium::bind_to_system_library())
            .map_err(|e| anyhow!("Failed to bind Pdfium library: {}", e))?;

        let pdfium = Pdfium::new(bindings);

        println!("🔧 PDF工作线程启动，Pdfium库路径: {}", library_path);

        Ok(Self {
            pdfium,
            docs: HashMap::new(),
            rx,
        })
    }

    pub fn run(&mut self) {
        println!("🚀 PDF工作线程开始运行");

        while let Ok(cmd) = self.rx.recv() {
            match cmd {
                PdfCmd::Open { id, bytes, resp } => {
                    let result = self.handle_open(id, bytes);
                    let _ = resp.send(result);
                }
                PdfCmd::RenderTile {
                    id,
                    page,
                    scale_x100,
                    tx_idx,
                    ty_idx,
                    resp,
                } => {
                    let result = self.handle_render_tile(id, page, scale_x100, tx_idx, ty_idx);
                    let _ = resp.send(result);
                }
                PdfCmd::TextLayout { id, page, resp } => {
                    let result = self.handle_text_layout(id, page);
                    let _ = resp.send(result);
                }
                PdfCmd::ExtractRange {
                    id,
                    page,
                    start,
                    end,
                    resp,
                } => {
                    let result = self.handle_extract_range(id, page, start, end);
                    let _ = resp.send(result);
                }
                PdfCmd::Close { id } => {
                    self.handle_close(id);
                }
                PdfCmd::Shutdown => {
                    println!("📴 PDF工作线程收到关闭信号");
                    self.cleanup_all_docs();
                    break;
                }
            }
        }

        println!("🛑 PDF工作线程已停止");
    }

    fn handle_open(&mut self, id: String, bytes: Vec<u8>) -> Result<types::PdfMetadata> {
        let start_time = Instant::now();

        unsafe {
            // 使用 FPDF_LoadMemDocument64 加载文档
            let bindings = self.pdfium.bindings();
            let doc = bindings.FPDF_LoadMemDocument64(&bytes, None);

            if doc.is_null() {
                return Err(anyhow!("FPDF_LoadMemDocument64 failed"));
            }

            let page_count = bindings.FPDF_GetPageCount(doc) as u32;
            let mut page_dims = Vec::with_capacity(page_count as usize);

            for i in 0..page_count {
                let mut size = pdfium_render::prelude::FS_SIZEF {
                    width: 0.0,
                    height: 0.0,
                };
                bindings.FPDF_GetPageSizeByIndexF(doc, i as i32, &mut size);
                page_dims.push((size.width, size.height));
            }

            // 如果已存在同ID文档，先清理
            if let Some(mut old_entry) = self.docs.remove(&id) {
                old_entry.cleanup(bindings);
            }

            // 创建新的文档条目
            let doc_entry = DocEntry::new(bytes, doc, page_dims.clone(), page_count);
            self.docs.insert(id.clone(), doc_entry);

            let metadata = types::PdfMetadata {
                id,
                total_pages: page_count,
                page_dims,
            };

            println!(
                "✅ PDF文档加载完成，耗时: {:?}, 页数: {}",
                start_time.elapsed(),
                page_count
            );
            Ok(metadata)
        }
    }

    fn handle_render_tile(
        &mut self,
        id: String,
        page: u32,
        scale_x100: u32,
        tx_idx: u32,
        ty_idx: u32,
    ) -> Result<Vec<u8>> {
        let start_time = Instant::now();

        let entry = self
            .docs
            .get_mut(&id)
            .ok_or_else(|| anyhow!("Document not found: {}", id))?;

        entry.update_last_used();

        let (w_pt, h_pt) = entry.page_dims[page as usize];
        let zoom = scale_x100 as f32 / 100.0;
        let effective_dpi = (BASE_DPI * zoom).clamp(MIN_DPI, MAX_DPI);
        let s = effective_dpi / 72.0;

        let w_px = ((w_pt / 72.0) * effective_dpi).ceil() as i32;
        let h_px = ((h_pt / 72.0) * effective_dpi).ceil() as i32;

        let dpi_scale = effective_dpi / BASE_DPI;
        let tile = (TILE_SIZE as f32 * dpi_scale).round() as i32;
        let x_px = tx_idx as i32 * tile;
        let y_px = ty_idx as i32 * tile;

        if x_px >= w_px || y_px >= h_px {
            return Err(anyhow!("Tile out of bounds"));
        }

        let tw = std::cmp::min(tile, w_px - x_px).max(1);
        let th = std::cmp::min(tile, h_px - y_px).max(1);

        unsafe {
            // 获取或加载页面
            let bindings = self.pdfium.bindings();
            let page_handle = entry
                .get_or_load_page(page, bindings)
                .ok_or_else(|| anyhow!("Failed to load page {}", page))?;

            // 创建位图
            let bmp = bindings.FPDFBitmap_CreateEx(tw, th, 4, std::ptr::null_mut(), 0);
            if bmp.is_null() {
                return Err(anyhow!("FPDFBitmap_CreateEx failed"));
            }

            // 填充背景
            bindings.FPDFBitmap_FillRect(bmp, 0, 0, tw, th, 0x00000000);

            // 计算渲染矩阵
            let bleed_pt = 1.0 / s;
            let left_pt = (x_px as f32) / s - bleed_pt;
            let top_pt = (y_px as f32) / s - bleed_pt;

            let mut matrix = pdfium_render::prelude::FS_MATRIX {
                a: s,
                b: 0.0,
                c: 0.0,
                d: s,
                e: -s * left_pt,
                f: -s * top_pt,
            };

            let clip = pdfium_render::prelude::FS_RECTF {
                left: 0.0,
                top: 0.0,
                right: tw as f32,
                bottom: th as f32,
            };

            // 渲染页面到位图
            let flags = 0x01 | 0x02; // FPDF_LCD_TEXT | FPDF_ANNOT
            bindings.FPDF_RenderPageBitmapWithMatrix(bmp, page_handle, &mut matrix, &clip, flags);

            // 获取像素数据并转换为RGBA
            let buf = bindings.FPDFBitmap_GetBuffer(bmp) as *const u8;
            let stride = bindings.FPDFBitmap_GetStride(bmp) as usize;
            let src = std::slice::from_raw_parts(buf, stride * (th as usize));

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
            bindings.FPDFBitmap_Destroy(bmp);

            // 编码为WebP
            let webp = webp::Encoder::from_rgba(&rgba, tw as u32, th as u32)
                .encode(WEBP_QUALITY as f32)
                .to_vec();

            println!(
                "🎨 瓦片渲染完成 - 页面:{} 瓦片:{}x{} 缩放:{} 尺寸:{}x{} 耗时:{:?}",
                page,
                tx_idx,
                ty_idx,
                scale_x100,
                tw,
                th,
                start_time.elapsed()
            );

            Ok(webp)
        }
    }

    fn handle_text_layout(&mut self, id: String, page: u32) -> Result<PageTextLayout> {
        let entry = self
            .docs
            .get_mut(&id)
            .ok_or_else(|| anyhow!("Document not found: {}", id))?;

        entry.update_last_used();

        let (w_pt, h_pt) = entry.page_dims[page as usize];

        unsafe {
            let bindings = self.pdfium.bindings();
            let page_handle = entry
                .get_or_load_page(page, bindings)
                .ok_or_else(|| anyhow!("Failed to load page {}", page))?;

            // 加载文本页面
            let text_page = bindings.FPDFText_LoadPage(page_handle);
            if text_page.is_null() {
                return Err(anyhow!("FPDFText_LoadPage failed"));
            }

            let count = bindings.FPDFText_CountChars(text_page) as i32;
            let mut chars = Vec::with_capacity(count as usize);

            for i in 0..count {
                let ch = bindings.FPDFText_GetUnicode(text_page, i);

                let mut left = 0f64;
                let mut right = 0f64;
                let mut bottom = 0f64;
                let mut top = 0f64;
                bindings.FPDFText_GetCharBox(
                    text_page,
                    i,
                    &mut left,
                    &mut right,
                    &mut bottom,
                    &mut top,
                );

                chars.push(CharBox {
                    idx: i as u32,
                    ch: std::char::from_u32(ch as u32).unwrap_or(' ').to_string(),
                    left: left as f32,
                    right: right as f32,
                    top: top as f32,
                    bottom: bottom as f32,
                });
            }

            bindings.FPDFText_ClosePage(text_page);

            Ok(PageTextLayout {
                width_pt: w_pt,
                height_pt: h_pt,
                chars,
            })
        }
    }

    fn handle_extract_range(
        &mut self,
        id: String,
        page: u32,
        start: u32,
        end: u32,
    ) -> Result<String> {
        let entry = self
            .docs
            .get_mut(&id)
            .ok_or_else(|| anyhow!("Document not found: {}", id))?;

        entry.update_last_used();

        unsafe {
            let bindings = self.pdfium.bindings();
            let page_handle = entry
                .get_or_load_page(page, bindings)
                .ok_or_else(|| anyhow!("Failed to load page {}", page))?;

            let text_page = bindings.FPDFText_LoadPage(page_handle);
            if text_page.is_null() {
                return Err(anyhow!("FPDFText_LoadPage failed"));
            }

            let mut result = String::new();
            for i in start as i32..=end as i32 {
                let ch = bindings.FPDFText_GetUnicode(text_page, i);
                result.push(std::char::from_u32(ch as u32).unwrap_or(' '));
            }

            bindings.FPDFText_ClosePage(text_page);
            Ok(result)
        }
    }

    fn handle_close(&mut self, id: String) {
        if let Some(mut entry) = self.docs.remove(&id) {
            let bindings = self.pdfium.bindings();
            entry.cleanup(bindings);
            println!("🗑️ 文档已关闭: {}", id);
        }
    }

    fn cleanup_all_docs(&mut self) {
        let bindings = self.pdfium.bindings();
        for (id, mut entry) in self.docs.drain() {
            entry.cleanup(bindings);
            println!("🗑️ 清理文档: {}", id);
        }
    }
}

// 启动PDF工作线程的函数
pub fn spawn_pdf_worker(library_path: String) -> Result<PdfWorkerHandle> {
    let (tx, rx) = unbounded::<PdfCmd>();

    std::thread::spawn(move || match PdfWorker::new(library_path, rx) {
        Ok(mut worker) => {
            worker.run();
        }
        Err(e) => {
            eprintln!("❌ PDF工作线程启动失败: {}", e);
        }
    });

    Ok(PdfWorkerHandle { tx })
}
