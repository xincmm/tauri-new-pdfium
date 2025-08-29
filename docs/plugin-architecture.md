# PDF 查看器插件架构设计

## 概述

本文档描述了PDF查看器的新插件架构设计，该架构旨在提供一个可扩展、模块化的PDF处理系统，同时保持与现有代码的向后兼容性。

## 架构层次

```
┌─────────────────────────────────────────┐
│                React UI Layer           │  ← PdfViewerV2, Components
├─────────────────────────────────────────┤
│              Plugin System              │  ← TextSelection, Annotations, Search
├─────────────────────────────────────────┤
│             Core API Layer              │  ← DocumentManager, EventBus, StateManager
├─────────────────────────────────────────┤
│            Tauri Commands               │  ← open_pdf, get_page_text_layout
├─────────────────────────────────────────┤
│              Rust Backend               │  ← PDFium bindings
└─────────────────────────────────────────┘
```

## 核心组件

### 1. 类型系统 (`src/types/pdf-core.ts`)

#### PDFium Core API Types
- `DocumentHandle`: 文档句柄管理
- `PageHandle`: 页面句柄管理  
- `TextPageHandle`: 文本页面句柄管理
- `RenderOptions`: 渲染选项配置
- `ErrorCode`: 标准错误码

#### React Layer Types
- `DocumentManager`: 文档生命周期管理接口
- `Plugin`: 插件基础接口
- `PluginContext`: 插件上下文接口
- `EventBus`: 事件总线接口
- `StateManager`: 状态管理接口

#### 预定义插件接口
- `TextSelectionPlugin`: 文本选择插件接口
- `AnnotationPlugin`: 注释插件接口
- `SearchPlugin`: 搜索插件接口

### 2. 文档管理器 (`src/core/DocumentManager.ts`)

负责封装与Tauri后端的交互，提供标准化的PDF操作API：

```typescript
// 文档操作
await documentManager.openFromPath(filePath);
await documentManager.close(documentId);

// 页面操作
const pageHandle = await documentManager.loadPage(documentId, pageIndex);
await documentManager.closePage(pageHandle);

// 文本操作
const textPageHandle = await documentManager.loadTextPage(pageHandle);
const text = await documentManager.getTextInRange(textPageHandle, start, count);
```

**特点**：
- 资源自动管理（句柄缓存和清理）
- 错误统一处理
- 与现有Tauri命令兼容
- 支持多文档并发

### 3. 插件系统 (`src/core/PluginSystem.ts`)

#### EventBus（事件总线）
```typescript
const eventBus = pluginManager.getEventBus();

// 监听事件
eventBus.on('text:selected', (data) => {
  console.log('Text selected:', data.selection);
});

// 发射事件
eventBus.emit('document:opened', { documentId, metadata });
```

#### StateManager（状态管理）
```typescript
const stateManager = pluginManager.getStateManager();

// 设置状态
stateManager.setState('text-selection:current', selection);

// 订阅状态变化
const unsubscribe = stateManager.subscribe('text-selection:current', (selection) => {
  console.log('Selection changed:', selection);
});
```

#### PluginManager（插件管理器）
```typescript
// 注册插件
const textPlugin = new TextSelectionPlugin();
await pluginManager.registerPlugin(textPlugin);

// 获取插件
const plugin = pluginManager.getPlugin<TextSelectionPlugin>('text-selection');

// 执行命令
await pluginManager.getPluginContext().executeCommand('text-selection:select', 0, 10, 0, 20);
```

## 插件开发

### 1. 基础插件结构

```typescript
export class MyPlugin implements ReactPDF.Plugin {
  name = 'my-plugin';
  version = '1.0.0';
  dependencies = ['text-selection']; // 可选

  async initialize(context: ReactPDF.PluginContext): Promise<void> {
    // 注册命令
    context.registerCommand('my-plugin:action', this.handleAction.bind(this));
    
    // 监听事件
    context.eventBus.on('document:opened', this.onDocumentOpened.bind(this));
    
    // 初始化状态
    context.stateManager.setState('my-plugin:data', {});
  }

  async destroy(): Promise<void> {
    // 清理资源
    this.context.unregisterCommand('my-plugin:action');
  }

  private async handleAction(): Promise<void> {
    // 命令处理逻辑
  }

  private onDocumentOpened(event: PDFEvents.DocumentOpened): void {
    // 文档打开事件处理
  }
}
```

### 2. 文本选择插件示例

```typescript
// 使用插件
const textPlugin = pluginManager.getPlugin<TextSelectionPlugin>('text-selection');

// 选择文本
const text = await textPlugin.selectText(0, 10, 0, 50);

// 开始跨页选区
textPlugin.startCrossPageSelection(0, 10);
textPlugin.updateCrossPageSelection(1, 20);
const crossPageText = await textPlugin.endCrossPageSelection();
```

## 渐进式迁移策略

### 阶段1：基础架构（当前阶段）
- ✅ 创建核心类型定义
- ✅ 实现文档管理器
- ✅ 实现插件系统核心
- ✅ 创建文本选择插件
- ✅ 创建PdfViewerV2组件

### 阶段2：功能迁移
- 🔄 将现有文本选择功能迁移到插件
- 🔄 创建注释插件
- 🔄 创建搜索插件
- 🔄 优化性能和内存管理

### 阶段3：扩展功能
- ⏳ 添加表单填写插件
- ⏳ 添加书签插件
- ⏳ 添加打印插件
- ⏳ 添加导出插件

### 阶段4：完全迁移
- ⏳ 替换所有现有组件
- ⏳ 移除旧的状态管理
- ⏳ 统一API接口

## 使用方式

### 1. 在现有项目中启用

```typescript
// 替换原有的 PdfViewer
import { PdfViewerV2 } from './components/PdfViewer/PdfViewerV2';

function App() {
  return <PdfViewerV2 />;
}
```

### 2. 访问插件功能

```typescript
// 在组件中使用插件
function MyComponent() {
  const [pluginsReady, setPluginsReady] = useState(false);
  
  useEffect(() => {
    // 等待插件系统初始化
    const checkPlugins = () => {
      if (pluginManager.isPluginRegistered('text-selection')) {
        setPluginsReady(true);
      }
    };
    
    const interval = setInterval(checkPlugins, 100);
    return () => clearInterval(interval);
  }, []);
  
  const handleSelectText = async () => {
    if (!pluginsReady) return;
    
    const textPlugin = pluginManager.getPlugin<TextSelectionPlugin>('text-selection');
    const text = await textPlugin.selectText(0, 10, 0, 50);
    console.log('Selected text:', text);
  };
  
  return (
    <button onClick={handleSelectText} disabled={!pluginsReady}>
      Select Text
    </button>
  );
}
```

## 兼容性保证

### 1. 现有组件保持不变
- `PdfViewer.tsx` - 原有组件继续可用
- `PdfContent.tsx` - 现有渲染逻辑不变
- `PdfTextLayer.tsx` - 现有文本层不变

### 2. 现有状态管理保持兼容
- `usePdfState` - 继续可用
- 现有的状态结构不变
- 渐进式迁移，不破坏现有功能

### 3. 现有工具函数保持可用
- `pdfLayout.ts` - 布局计算不变
- `tileUtils.ts` - 瓦片工具不变
- `scrollOptimization.ts` - 滚动优化不变

## 性能优化

### 1. 懒加载插件
```typescript
// 按需加载插件
const loadAnnotationPlugin = async () => {
  const { AnnotationPlugin } = await import('./plugins/AnnotationPlugin');
  await pluginManager.registerPlugin(new AnnotationPlugin());
};
```

### 2. 事件防抖
```typescript
// 事件总线自动防抖高频事件
eventBus.on('scroll:update', debounce((data) => {
  // 处理滚动更新
}, 16)); // 60fps
```

### 3. 状态优化
```typescript
// 状态管理器支持批量更新
stateManager.batch(() => {
  stateManager.setState('key1', value1);
  stateManager.setState('key2', value2);
  // 只触发一次订阅者回调
});
```

## 调试和监控

### 1. 开发工具
```typescript
// 在控制台查看插件信息
console.log('Plugins:', pluginManager.getRegisteredPlugins());
console.log('Commands:', pluginManager.getPluginContext().getRegisteredCommands());
console.log('Event listeners:', pluginManager.getEventBus().getListenerCount());
```

### 2. 性能监控
```typescript
// 插件性能监控
const performancePlugin = new PerformanceMonitorPlugin();
await pluginManager.registerPlugin(performancePlugin);
```

### 3. 错误处理
```typescript
// 全局错误处理
pluginManager.getEventBus().on('error', (error) => {
  console.error('Plugin error:', error);
  // 发送到错误监控服务
});
```

## 未来扩展

### 1. 后端API扩展
```rust
// 新的 Tauri 命令
#[tauri::command]
async fn render_page_rect(
    document_id: String,
    page_index: u32,
    rect: PageRect,
    options: RenderOptions
) -> Result<Vec<u8>, String> {
    // 实现矩形区域渲染
}
```

### 2. 插件市场
- 支持第三方插件开发
- 插件版本管理
- 插件依赖解析
- 插件安全沙箱

### 3. 云端集成
- 云端文档存储
- 协作编辑
- 实时同步
- 版本控制

## 总结

新的插件架构提供了：

1. **可扩展性**: 通过插件系统轻松添加新功能
2. **模块化**: 功能解耦，易于维护和测试
3. **兼容性**: 与现有代码完全兼容，渐进式迁移
4. **标准化**: 统一的API接口和错误处理
5. **性能优化**: 懒加载、事件防抖、批量更新等优化
6. **开发友好**: 丰富的调试工具和文档

这个架构为PDF查看器的长期发展奠定了坚实的基础，支持未来的功能扩展和性能优化需求。 