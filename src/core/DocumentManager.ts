// PDF 文档管理器 - 封装 Tauri 命令系统
import { invoke } from '@tauri-apps/api/core';
import { PDFiumCore, ReactPDF } from '../types/pdf-core';

// 兼容现有类型的适配器
import { PdfMetadata, PageTextLayout } from '../types/pdf';

/**
 * PDF 文档管理器
 * 提供标准化的 PDFium API 封装，兼容现有系统
 */
export class DocumentManager implements ReactPDF.DocumentManager {
  private documents = new Map<string, PDFiumCore.DocumentHandle>();
  private pages = new Map<string, PDFiumCore.PageHandle>();
  private textPages = new Map<string, PDFiumCore.TextPageHandle>();

  async initialize(): Promise<void> {
    // 初始化 PDFium 库（如果需要）
    // 目前直接使用现有的 Tauri 命令
    console.log('DocumentManager initialized');
  }

  async destroy(): Promise<void> {
    // 清理所有资源
    const documentIds = Array.from(this.documents.keys());
    for (const id of documentIds) {
      await this.close(id);
    }
    this.documents.clear();
    this.pages.clear();
    this.textPages.clear();
  }

  // ============= 文档操作 =============
  async openFromUrl(_url: string): Promise<PDFiumCore.DocumentHandle> {
    throw new Error('URL loading not implemented yet');
  }

  async openFromBuffer(_buffer: ArrayBuffer): Promise<PDFiumCore.DocumentHandle> {
    throw new Error('Buffer loading not implemented yet');
  }

  /**
   * 兼容现有的文件路径打开方式
   */
  async openFromPath(path: string): Promise<PDFiumCore.DocumentHandle> {
    try {
      // 使用现有的 Tauri 命令
      const metadata = await invoke<PdfMetadata>('open_pdf', { path });
      
      const handle: PDFiumCore.DocumentHandle = {
        id: metadata.id,
        handle: 0, // 暂时不需要底层handle
        metadata: {
          pageCount: metadata.total_pages,
          pageDimensions: metadata.page_dims.map(([width, height]) => ({ width, height })),
          version: '1.0', // 暂时硬编码
        }
      };

      this.documents.set(metadata.id, handle);
      return handle;
    } catch (error) {
      throw this.wrapError(error, 'Failed to open PDF from path');
    }
  }

  async close(documentId: string): Promise<void> {
    const document = this.documents.get(documentId);
    if (!document) return;

    // 清理相关的页面和文本页面
    const pagesToRemove: string[] = [];
    const textPagesToRemove: string[] = [];

    Array.from(this.pages.entries()).forEach(([key, page]) => {
      if (page.documentId === documentId) {
        pagesToRemove.push(key);
      }
    });

    Array.from(this.textPages.entries()).forEach(([key, textPage]) => {
      if (textPage.pageHandle.documentId === documentId) {
        textPagesToRemove.push(key);
      }
    });

    // 清理页面
    for (const key of pagesToRemove) {
      this.pages.delete(key);
    }

    // 清理文本页面
    for (const key of textPagesToRemove) {
      this.textPages.delete(key);
    }

    this.documents.delete(documentId);
    
    // 这里可以调用后端的清理命令（如果有的话）
    console.log(`Document ${documentId} closed and resources cleaned up`);
  }

  // ============= 页面操作 =============
  async loadPage(documentId: string, pageIndex: number): Promise<PDFiumCore.PageHandle> {
    const document = this.documents.get(documentId);
    if (!document) {
      throw new Error(`Document ${documentId} not found`);
    }

    const pageKey = `${documentId}:${pageIndex}`;
    const existingPage = this.pages.get(pageKey);
    if (existingPage) {
      return existingPage;
    }

    // 获取页面尺寸
    const pageDim = document.metadata.pageDimensions[pageIndex];
    if (!pageDim) {
      throw new Error(`Page ${pageIndex} not found in document ${documentId}`);
    }

    const pageHandle: PDFiumCore.PageHandle = {
      documentId,
      pageIndex,
      handle: 0, // 暂时不需要底层handle
      width: pageDim.width,
      height: pageDim.height,
    };

    this.pages.set(pageKey, pageHandle);
    return pageHandle;
  }

  async closePage(pageHandle: PDFiumCore.PageHandle): Promise<void> {
    const pageKey = `${pageHandle.documentId}:${pageHandle.pageIndex}`;
    this.pages.delete(pageKey);
    
    // 同时清理相关的文本页面
    this.textPages.delete(pageKey);
  }

  // ============= 文本操作 =============
  async loadTextPage(pageHandle: PDFiumCore.PageHandle): Promise<PDFiumCore.TextPageHandle> {
    const pageKey = `${pageHandle.documentId}:${pageHandle.pageIndex}`;
    const existingTextPage = this.textPages.get(pageKey);
    if (existingTextPage) {
      return existingTextPage;
    }

    try {
      // 使用现有的 Tauri 命令获取文本布局
      const textLayout = await invoke<PageTextLayout>('get_page_text_layout', {
        id: pageHandle.documentId,
        page: pageHandle.pageIndex
      });

      const textPageHandle: PDFiumCore.TextPageHandle = {
        pageHandle,
        handle: 0, // 暂时不需要底层handle
        charCount: textLayout.chars.length,
      };

      this.textPages.set(pageKey, textPageHandle);
      return textPageHandle;
    } catch (error) {
      throw this.wrapError(error, `Failed to load text page ${pageHandle.pageIndex}`);
    }
  }

  async getTextInRange(
    textPageHandle: PDFiumCore.TextPageHandle,
    startIndex: number,
    count: number
  ): Promise<string> {
    try {
      // 重新获取文本布局（或从缓存获取）
      const textLayout = await invoke<PageTextLayout>('get_page_text_layout', {
        id: textPageHandle.pageHandle.documentId,
        page: textPageHandle.pageHandle.pageIndex
      });

      const endIndex = Math.min(startIndex + count, textLayout.chars.length);
      const chars = textLayout.chars.slice(startIndex, endIndex);
      return chars.map(c => c.ch).join('');
    } catch (error) {
      throw this.wrapError(error, 'Failed to get text in range');
    }
  }

  async closeTextPage(textPageHandle: PDFiumCore.TextPageHandle): Promise<void> {
    const pageKey = `${textPageHandle.pageHandle.documentId}:${textPageHandle.pageHandle.pageIndex}`;
    this.textPages.delete(pageKey);
  }

  // ============= 渲染操作 =============
  async renderPage(
    _pageHandle: PDFiumCore.PageHandle,
    _options: PDFiumCore.RenderOptions
  ): Promise<ImageBitmap> {
    // 这里需要实现新的渲染命令，目前抛出错误
    throw new Error('Direct page rendering not implemented - use existing tile system');
  }

  async renderPageRect(
    _pageHandle: PDFiumCore.PageHandle,
    _rect: DOMRect,
    _options: PDFiumCore.RenderOptions
  ): Promise<ImageBitmap> {
    // 这里需要实现矩形区域渲染，目前抛出错误
    throw new Error('Page rect rendering not implemented - use existing tile system');
  }

  // ============= 兼容性方法 =============
  /**
   * 获取现有格式的文档元数据
   */
  getLegacyMetadata(documentId: string): PdfMetadata | null {
    const document = this.documents.get(documentId);
    if (!document) return null;

    return {
      id: document.id,
      total_pages: document.metadata.pageCount,
      page_dims: document.metadata.pageDimensions.map(dim => [dim.width, dim.height] as [number, number])
    };
  }

  /**
   * 获取已加载的文档列表
   */
  getLoadedDocuments(): string[] {
    return Array.from(this.documents.keys());
  }

  /**
   * 检查文档是否已加载
   */
  isDocumentLoaded(documentId: string): boolean {
    return this.documents.has(documentId);
  }

  // ============= 私有方法 =============
  private wrapError(error: any, context: string): PDFiumCore.PDFError {
    return {
      code: PDFiumCore.ErrorCode.UNKNOWN,
      message: error.message || 'Unknown error',
      details: { context, originalError: error }
    };
  }
}

// 全局单例实例
export const documentManager = new DocumentManager(); 