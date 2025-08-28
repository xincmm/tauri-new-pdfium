use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// 优化瓦片尺寸和质量参数
pub const TILE_SIZE: u32 = 512;
pub const BASE_DPI: f32 = 150.0;
pub const WEBP_QUALITY: u8 = 75;
pub const MAX_DPI: f32 = 1000.0;
pub const MIN_DPI: f32 = 36.0;

#[derive(Serialize, Deserialize, Debug)]
pub struct PdfMetadata {
    pub id: String,
    pub total_pages: u32,
    pub page_dims: Vec<(f32, f32)>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TextItem {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub font_size: f32,
    pub font_name: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PageTextContent {
    pub page: u32,
    pub text_items: Vec<TextItem>,
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

// 持久化的文档数据结构，存储字节数据和页面信息
pub struct PdfData {
    pub bytes: Vec<u8>,
    pub page_dims: Vec<(f32, f32)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TileKey {
    pub id: String,
    pub page: u32,
    pub scale_x100: u32,
    pub tx: u32,
    pub ty: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PageKey {
    pub id: String,
    pub page: u32,
    pub scale_x100: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RenderingKey {
    pub id: String,
    pub page: u32,
    pub scale_x100: u32,
}

// 文档条目，长期驻留在工作线程中
pub struct DocEntry {
    pub bytes: Vec<u8>, // 必须驻留，保证 FPDF_LoadMemDocument 的内存有效
    pub doc: pdfium_render::prelude::FPDF_DOCUMENT,
    pub page_dims: Vec<(f32, f32)>,
    pub total_pages: u32,
    pub last_used: std::time::Instant,
    // 页句柄缓存
    pub pages: HashMap<u32, pdfium_render::prelude::FPDF_PAGE>,
}

impl DocEntry {
    pub fn new(
        bytes: Vec<u8>,
        doc: pdfium_render::prelude::FPDF_DOCUMENT,
        page_dims: Vec<(f32, f32)>,
        total_pages: u32,
    ) -> Self {
        Self {
            bytes,
            doc,
            page_dims,
            total_pages,
            last_used: std::time::Instant::now(),
            pages: HashMap::new(),
        }
    }

    pub fn update_last_used(&mut self) {
        self.last_used = std::time::Instant::now();
    }

    pub fn get_or_load_page(
        &mut self,
        page: u32,
        bindings: &dyn pdfium_render::prelude::PdfiumLibraryBindings,
    ) -> Option<pdfium_render::prelude::FPDF_PAGE> {
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

    pub fn cleanup(&mut self, bindings: &dyn pdfium_render::prelude::PdfiumLibraryBindings) {
        unsafe {
            // 释放所有页句柄
            for (_, page_handle) in self.pages.drain() {
                bindings.FPDF_ClosePage(page_handle);
            }
            // 释放文档句柄
            bindings.FPDF_CloseDocument(self.doc);
        }
    }
}
