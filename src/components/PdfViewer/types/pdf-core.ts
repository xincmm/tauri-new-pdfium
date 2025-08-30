// PDF 核心类型定义 - 标准化API接口
// 这个文件定义了新的架构类型，与现有的 pdf.ts 并存

// ============= PDFium Core API Types =============
export namespace PDFiumCore {
  // 文档生命周期
  export interface DocumentHandle {
    id: string;
    handle: number; // 底层handle
    metadata: DocumentMetadata;
  }

  export interface DocumentMetadata {
    pageCount: number;
    pageDimensions: Array<{ width: number; height: number }>; // pt
    version: string;
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
    producer?: string;
    creationDate?: string;
    modificationDate?: string;
  }

  // 页面操作
  export interface PageHandle {
    documentId: string;
    pageIndex: number;
    handle: number;
    width: number; // pt
    height: number; // pt
  }

  // 文本操作
  export interface TextPageHandle {
    pageHandle: PageHandle;
    handle: number;
    charCount: number;
  }

  export interface CharInfo {
    index: number;
    char: string;
    bbox: { left: number; top: number; right: number; bottom: number }; // pt
    fontSize: number;
    fontName?: string;
  }

  // 渲染操作
  export interface RenderOptions {
    scale: number;
    rotation: number; // 0, 90, 180, 270
    backgroundColor?: string;
    flags?: RenderFlags;
  }

  export enum RenderFlags {
    ANNOT = 1, // 渲染注释
    LCD_TEXT = 2, // LCD文本优化
    NO_NATIVETEXT = 4, // 不使用原生文本
    GRAYSCALE = 8, // 灰度渲染
    DEBUG_INFO = 16, // 调试信息
    NO_CATCH = 32, // 不捕获异常
    RENDER_LIMITEDIMAGECACHE = 64, // 限制图片缓存
    RENDER_FORCEHALFTONE = 128, // 强制半色调
    PRINTING = 256, // 打印模式
    REVERSE_BYTE_ORDER = 512, // 反转字节序
  }

  // 错误处理
  export enum ErrorCode {
    SUCCESS = 0,
    UNKNOWN = 1,
    FILE = 2,
    FORMAT = 3,
    PASSWORD = 4,
    SECURITY = 5,
    PAGE = 6,
    XFALOAD = 7,
    XFALAYOUT = 8,
  }

  export interface PDFError {
    code: ErrorCode;
    message: string;
    details?: any;
  }
}

// ============= React Layer Types =============
export namespace ReactPDF {
  // 文档生命周期管理
  export interface DocumentManager {
    // 文档操作
    initialize(): Promise<void>;
    openFromUrl(url: string): Promise<PDFiumCore.DocumentHandle>;
    openFromBuffer(buffer: ArrayBuffer): Promise<PDFiumCore.DocumentHandle>;
    openFromPath(path: string): Promise<PDFiumCore.DocumentHandle>; // 兼容现有系统
    close(documentId: string): Promise<void>;
    destroy(): Promise<void>;

    // 页面操作
    loadPage(documentId: string, pageIndex: number): Promise<PDFiumCore.PageHandle>;
    closePage(pageHandle: PDFiumCore.PageHandle): Promise<void>;

    // 文本操作
    loadTextPage(pageHandle: PDFiumCore.PageHandle): Promise<PDFiumCore.TextPageHandle>;
    getTextInRange(textPageHandle: PDFiumCore.TextPageHandle, startIndex: number, count: number): Promise<string>;
    closeTextPage(textPageHandle: PDFiumCore.TextPageHandle): Promise<void>;

    // 渲染操作
    renderPage(pageHandle: PDFiumCore.PageHandle, options: PDFiumCore.RenderOptions): Promise<ImageBitmap>;
    renderPageRect(
      pageHandle: PDFiumCore.PageHandle,
      rect: DOMRect,
      options: PDFiumCore.RenderOptions,
    ): Promise<ImageBitmap>;

    // 兼容性方法
    getLoadedDocuments(): string[];
    isDocumentLoaded(documentId: string): boolean;
    getLegacyMetadata(documentId: string): any; // 返回现有格式的元数据
  }

  // 插件系统
  export interface Plugin {
    name: string;
    version: string;
    dependencies?: string[];
    initialize(context: PluginContext): Promise<void>;
    destroy(): Promise<void>;
  }

  export interface PluginContext {
    documentManager: DocumentManager;
    eventBus: EventBus;
    stateManager: StateManager;
    registerCommand(name: string, handler: CommandHandler): void;
    unregisterCommand(name: string): void;
  }

  export interface EventBus {
    on<T = any>(event: string, handler: (data: T) => void): void;
    off(event: string, handler: Function): void;
    emit<T = any>(event: string, data: T): void;
  }

  export interface StateManager {
    getState<T = any>(key: string): T | undefined;
    setState<T = any>(key: string, value: T): void;
    subscribe<T = any>(key: string, callback: (value: T) => void): () => void;
  }

  export type CommandHandler = (...args: any[]) => Promise<any> | any;

  // 预定义插件接口
  export interface TextSelectionPlugin extends Plugin {
    name: "text-selection";
    selectText(startPage: number, startChar: number, endPage: number, endChar: number): Promise<string>;
    clearSelection(): void;
    getSelection(): TextSelection | null;
  }

  export interface AnnotationPlugin extends Plugin {
    name: "annotations";
    getAllAnnotations(documentId: string): Promise<Annotation[]>;
    getPageAnnotations(documentId: string, pageIndex: number): Promise<Annotation[]>;
    createAnnotation(documentId: string, pageIndex: number, annotation: AnnotationData): Promise<Annotation>;
    updateAnnotation(annotationId: string, updates: Partial<AnnotationData>): Promise<Annotation>;
    removeAnnotation(annotationId: string): Promise<void>;
  }

  export interface SearchPlugin extends Plugin {
    name: "search";
    search(documentId: string, query: string, options?: SearchOptions): Promise<SearchResult[]>;
    highlightResults(results: SearchResult[]): void;
    clearHighlights(): void;
  }

  // 数据类型
  export interface TextSelection {
    startPage: number;
    endPage: number;
    startCharIndex: number;
    endCharIndex: number;
    text: string;
  }

  export interface Annotation {
    id: string;
    type: AnnotationType;
    pageIndex: number;
    rect: DOMRect;
    data: AnnotationData;
    createdAt: Date;
    updatedAt: Date;
  }

  export enum AnnotationType {
    TEXT = "text",
    HIGHLIGHT = "highlight",
    UNDERLINE = "underline",
    STRIKEOUT = "strikeout",
    SQUIGGLY = "squiggly",
    NOTE = "note",
    FREETEXT = "freetext",
    LINK = "link",
    WIDGET = "widget",
  }

  export interface AnnotationData {
    content?: string;
    color?: string;
    opacity?: number;
    author?: string;
    subject?: string;
    [key: string]: any;
  }

  export interface SearchOptions {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regex?: boolean;
    maxResults?: number;
  }

  export interface SearchResult {
    pageIndex: number;
    charIndex: number;
    length: number;
    text: string;
    rect: DOMRect;
  }
}

// ============= 事件类型 =============
export namespace PDFEvents {
  export interface DocumentOpened {
    documentId: string;
    metadata: PDFiumCore.DocumentMetadata;
  }

  export interface DocumentClosed {
    documentId: string;
  }

  export interface PageLoaded {
    documentId: string;
    pageIndex: number;
    pageHandle: PDFiumCore.PageHandle;
  }

  export interface TextSelected {
    selection: ReactPDF.TextSelection;
  }

  export interface AnnotationCreated {
    annotation: ReactPDF.Annotation;
  }

  export interface AnnotationUpdated {
    annotation: ReactPDF.Annotation;
  }

  export interface AnnotationDeleted {
    annotationId: string;
  }

  export interface SearchCompleted {
    query: string;
    results: ReactPDF.SearchResult[];
  }

  export interface RenderCompleted {
    documentId: string;
    pageIndex: number;
    renderTime: number;
  }

  export interface Error {
    error: PDFiumCore.PDFError;
    context?: string;
  }
}
