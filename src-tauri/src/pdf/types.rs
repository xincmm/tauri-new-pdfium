use serde::{Deserialize, Serialize};

// 基础常量
pub const TILE_SIZE: u32 = 512;
pub const BASE_DPI: f32 = 96.0;
pub const MAX_DPI: f32 = 1000.0;
pub const MIN_DPI: f32 = 36.0;

// PDF文档元数据 - 优化内存使用
#[derive(Serialize, Deserialize, Debug)]
pub struct PdfDocumentMetadata {
    pub id: String,
    pub total_pages: u32,
    // 去重的页面尺寸模板
    pub page_dimension_templates: Vec<(f32, f32)>,
    // 每页对应的模板索引
    pub page_template_indices: Vec<u16>,
}

// 瓦片请求数据结构（从worker.rs导出到这里）
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

// 文本相关类型（保留以支持文本功能）
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
