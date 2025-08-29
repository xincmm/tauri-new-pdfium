// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod pdf;

use pdf::{spawn_pdf_worker, PdfWorkerHandle, TileRequest};
use tauri::Manager;

// 全局静态变量存储 Pdfium 库路径
static PDFIUM_LIBRARY_PATH: once_cell::sync::OnceCell<String> = once_cell::sync::OnceCell::new();

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn load_pdf(
    file_path: String,
    worker: tauri::State<'_, PdfWorkerHandle>,
) -> Result<pdf::types::PdfDocumentMetadata, String> {
    worker.inner().load_document(file_path)
}

#[tauri::command]
async fn render_tiles_batch(
    requests: Vec<TileRequest>,
    worker: tauri::State<'_, PdfWorkerHandle>,
) -> Result<Vec<u8>, String> {
    let results = worker.inner().render_tiles_batch(requests)?;
    
    // 将所有瓦片打包成单一字节数组，使用Raw传输
    // 格式: [瓦片数量(4字节)] [瓦片1长度(4字节)] [瓦片1数据] [瓦片2长度(4字节)] [瓦片2数据] ...
    let mut packed_data = Vec::new();
    let tile_count = results.len();
    
    // 写入瓦片数量
    packed_data.extend_from_slice(&(tile_count as u32).to_le_bytes());
    
    // 写入每个瓦片的长度和数据
    for result in results {
        let tile_data = result.data;
        // 写入瓦片数据长度
        packed_data.extend_from_slice(&(tile_data.len() as u32).to_le_bytes());
        // 写入瓦片数据
        packed_data.extend_from_slice(&tile_data);
    }
    
    println!("📦 打包完成: {} 个瓦片，总大小 {} bytes", 
        tile_count, packed_data.len());
    
    Ok(packed_data)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::path::BaseDirectory;

            let rel_path = if cfg!(target_os = "macos") {
                "runtime/libpdfium.dylib-aarch64-apple-darwin"
            } else if cfg!(target_os = "windows") {
                "runtime/pdfium.dll"
            } else {
                "runtime/libpdfium.so"
            };

            let lib_path = app
                .path()
                .resolve(rel_path, BaseDirectory::Resource)
                .unwrap_or_else(|_| std::path::PathBuf::from(rel_path));

            let library_path = lib_path.to_string_lossy().to_string();

            // 设置全局 Pdfium 库路径
            PDFIUM_LIBRARY_PATH.set(library_path.clone()).unwrap();
            
            // 启动PDF工作线程
            let worker = spawn_pdf_worker(library_path.clone())
                .expect("Failed to spawn PDF worker");
            
            // 注册状态
            app.manage(worker);

            println!("🚀 Tauri应用初始化完成, PDF工作线程已启动, library_path: {}", library_path);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, load_pdf, render_tiles_batch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
