pub mod cache;
pub mod commands;
pub mod types;
pub mod worker;

// 导出主要的类型和函数
pub use worker::{spawn_pdf_worker, PdfWorkerHandle, TileRequest, TileRenderResult};
pub use types::PdfDocumentMetadata;
