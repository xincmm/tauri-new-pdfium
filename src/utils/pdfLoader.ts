import { invoke } from '@tauri-apps/api/core';
import { PdfMetadata } from '../types/pdf';

// PDF加载器 - 使用新的IPC命令
export class PdfLoader {
  // 加载PDF文档
  async loadPdf(filePath: string): Promise<PdfMetadata> {
    try {
      const metadata = await invoke<PdfMetadata>('load_pdf', { 
        filePath: filePath 
      });
      
      console.log(`✅ PDF加载完成: ${metadata.total_pages} 页`);
      return metadata;
    } catch (error) {
      console.error('PDF加载失败:', error);
      throw error;
    }
  }
}

// 全局PDF加载器实例
export const pdfLoader = new PdfLoader(); 