// 文本选择插件 - 将现有的文本选择功能封装成插件
import { ReactPDF, PDFEvents } from '@/PdfViewer/types/pdf-core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

// 兼容现有的跨页选区类型
export interface CrossPageSelection {
  startPage: number;
  endPage: number;
  startCharIndex: number;
  endCharIndex: number;
  isSelecting: boolean;
}

/**
 * 文本选择插件
 * 封装现有的单页和跨页文本选择功能
 */
export class TextSelectionPlugin implements ReactPDF.TextSelectionPlugin {
  name = 'text-selection' as const;
  version = '1.0.0';

  private context!: ReactPDF.PluginContext;
  private currentSelection: ReactPDF.TextSelection | null = null;
  private crossPageSelection: CrossPageSelection | null = null;

  async initialize(context: ReactPDF.PluginContext): Promise<void> {
    this.context = context;

    // 注册命令
    context.registerCommand('text-selection:select', this.selectText.bind(this));
    context.registerCommand('text-selection:clear', this.clearSelection.bind(this));
    context.registerCommand('text-selection:get', this.getSelection.bind(this));
    context.registerCommand('text-selection:copy', this.copySelectionToClipboard.bind(this));

    // 注册跨页选区相关命令
    context.registerCommand('text-selection:startCrossPageSelection', this.startCrossPageSelection.bind(this));
    context.registerCommand('text-selection:updateCrossPageSelection', this.updateCrossPageSelection.bind(this));
    context.registerCommand('text-selection:endCrossPageSelection', this.endCrossPageSelection.bind(this));
    context.registerCommand('text-selection:getCrossPageSelection', this.getCrossPageSelection.bind(this));

    // 监听文档关闭事件，清理选区
    context.eventBus.on<PDFEvents.DocumentClosed>('document:closed', (_event) => {
      this.clearSelection();
    });

    // 初始化状态
    context.stateManager.setState('text-selection:current', null);
    context.stateManager.setState('text-selection:crossPage', null);

    console.log('TextSelectionPlugin initialized');
  }

  async destroy(): Promise<void> {
    // 清理状态
    this.clearSelection();
    
    // 注销命令
    this.context.unregisterCommand('text-selection:select');
    this.context.unregisterCommand('text-selection:clear');
    this.context.unregisterCommand('text-selection:get');
    this.context.unregisterCommand('text-selection:copy');
    this.context.unregisterCommand('text-selection:startCrossPageSelection');
    this.context.unregisterCommand('text-selection:updateCrossPageSelection');
    this.context.unregisterCommand('text-selection:endCrossPageSelection');
    this.context.unregisterCommand('text-selection:getCrossPageSelection');

    console.log('TextSelectionPlugin destroyed');
  }

  // ============= 实现接口方法 =============
  async selectText(startPage: number, startChar: number, endPage: number, endChar: number): Promise<string> {
    try {
      // 获取文档ID（假设当前只有一个活跃文档）
      const documentIds = this.context.documentManager.getLoadedDocuments();
      if (documentIds.length === 0) {
        throw new Error('No document loaded');
      }
      const documentId = documentIds[0]; // 使用第一个文档

      // 提取选中的文本
      const text = await this.extractTextRange(documentId, startPage, startChar, endPage, endChar);

      // 创建选区对象
      const selection: ReactPDF.TextSelection = {
        startPage,
        endPage,
        startCharIndex: startChar,
        endCharIndex: endChar,
        text
      };

      // 更新状态
      this.currentSelection = selection;
      this.context.stateManager.setState('text-selection:current', selection);

      // 发射事件
      this.context.eventBus.emit<PDFEvents.TextSelected>('text:selected', { selection });

      return text;
    } catch (error) {
      console.error('Failed to select text:', error);
      throw error;
    }
  }

  clearSelection(): void {
    this.currentSelection = null;
    this.crossPageSelection = null;
    
    this.context.stateManager.setState('text-selection:current', null);
    this.context.stateManager.setState('text-selection:crossPage', null);

    // 发射清除事件
    this.context.eventBus.emit('text:selectionCleared', {});
  }

  getSelection(): ReactPDF.TextSelection | null {
    return this.currentSelection;
  }

  // ============= 跨页选区方法 =============
  startCrossPageSelection(pageIndex: number, charIndex: number): void {
    this.crossPageSelection = {
      startPage: pageIndex,
      endPage: pageIndex,
      startCharIndex: charIndex,
      endCharIndex: charIndex,
      isSelecting: true
    };

    this.context.stateManager.setState('text-selection:crossPage', this.crossPageSelection);
    this.context.eventBus.emit('text:crossPageSelectionStarted', { 
      pageIndex, 
      charIndex 
    });
  }

  updateCrossPageSelection(pageIndex: number, charIndex: number): void {
    if (!this.crossPageSelection || !this.crossPageSelection.isSelecting) {
      return;
    }

    this.crossPageSelection.endPage = pageIndex;
    this.crossPageSelection.endCharIndex = charIndex;

    this.context.stateManager.setState('text-selection:crossPage', this.crossPageSelection);
    this.context.eventBus.emit('text:crossPageSelectionUpdated', {
      pageIndex,
      charIndex,
      selection: this.crossPageSelection
    });
  }

  async endCrossPageSelection(): Promise<string | null> {
    if (!this.crossPageSelection || !this.crossPageSelection.isSelecting) {
      return null;
    }

    try {
      // 提取跨页文本
      const text = await this.selectText(
        this.crossPageSelection.startPage,
        this.crossPageSelection.startCharIndex,
        this.crossPageSelection.endPage,
        this.crossPageSelection.endCharIndex
      );

      // 结束选择状态
      this.crossPageSelection.isSelecting = false;
      this.context.stateManager.setState('text-selection:crossPage', this.crossPageSelection);

      this.context.eventBus.emit('text:crossPageSelectionEnded', {
        selection: this.crossPageSelection,
        text
      });

      return text;
    } catch (error) {
      console.error('Failed to end cross-page selection:', error);
      this.crossPageSelection = null;
      this.context.stateManager.setState('text-selection:crossPage', null);
      throw error;
    }
  }

  getCrossPageSelection(): CrossPageSelection | null {
    return this.crossPageSelection;
  }

  // ============= 辅助方法 =============
  private async extractTextRange(
    documentId: string,
    startPage: number,
    startChar: number,
    endPage: number,
    endChar: number
  ): Promise<string> {
    const textParts: string[] = [];

    for (let pageIndex = startPage; pageIndex <= endPage; pageIndex++) {
      try {
        // 加载页面
        const pageHandle = await this.context.documentManager.loadPage(documentId, pageIndex);
        
        // 加载文本页面
        const textPageHandle = await this.context.documentManager.loadTextPage(pageHandle);

        // 计算该页面的字符范围
        let pageStartChar = 0;
        let pageEndChar = textPageHandle.charCount - 1;

        if (pageIndex === startPage) {
          pageStartChar = Math.max(0, startChar);
        }
        if (pageIndex === endPage) {
          pageEndChar = Math.min(textPageHandle.charCount - 1, endChar);
        }

        // 提取文本
        const charCount = pageEndChar - pageStartChar + 1;
        if (charCount > 0) {
          const pageText = await this.context.documentManager.getTextInRange(
            textPageHandle,
            pageStartChar,
            charCount
          );

          if (pageText.trim()) {
            textParts.push(pageText);
          }
        }

        // 清理文本页面（可选，取决于DocumentManager的缓存策略）
        // await this.context.documentManager.closeTextPage(textPageHandle);
      } catch (error) {
        console.error(`Failed to extract text from page ${pageIndex}:`, error);
        // 继续处理其他页面
      }
    }

    return textParts.join('\n');
  }

  private async copySelectionToClipboard(): Promise<void> {
    if (!this.currentSelection) {
      throw new Error('No text selected');
    }

    try {
      await writeText(this.currentSelection.text);
      this.context.eventBus.emit('text:copiedToClipboard', {
        text: this.currentSelection.text,
        length: this.currentSelection.text.length
      });
    } catch (error) {
      console.error('Failed to copy text to clipboard:', error);
      throw error;
    }
  }

  // ============= React Hook 兼容方法 =============
  /**
   * 创建一个React Hook来使用文本选择功能
   */
  createReactHook() {
    return {
      useTextSelection: () => {
        const selection = this.context.stateManager.getState<ReactPDF.TextSelection | null>('text-selection:current');
        const crossPageSelection = this.context.stateManager.getState<CrossPageSelection | null>('text-selection:crossPage');

        return {
          selection,
          crossPageSelection,
          selectText: this.selectText.bind(this),
          clearSelection: this.clearSelection.bind(this),
          startCrossPageSelection: this.startCrossPageSelection.bind(this),
          updateCrossPageSelection: this.updateCrossPageSelection.bind(this),
          endCrossPageSelection: this.endCrossPageSelection.bind(this),
          copyToClipboard: this.copySelectionToClipboard.bind(this)
        };
      }
    };
  }
} 