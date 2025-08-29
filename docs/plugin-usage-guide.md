# PDF查看器插件使用指南

## 目录
1. [快速开始](#快速开始)
2. [内置插件介绍](#内置插件介绍)
3. [插件安装和管理](#插件安装和管理)
4. [常用功能使用](#常用功能使用)
5. [自定义配置](#自定义配置)
6. [故障排除](#故障排除)

## 快速开始

### 启用插件系统

1. **切换到插件版本**
   - 打开PDF查看器
   - 点击右上角的版本切换器
   - 选择"使用插件架构版本 (V2)"

2. **查看插件状态**
   - 查看左下角的绿色插件指示器
   - 点击指示器可以查看已安装的插件列表
   - 开发模式下可以看到详细的调试信息

### 基本操作

```typescript
// 在浏览器控制台中查看插件信息
console.log('已注册插件:', pluginManager.getRegisteredPlugins());
console.log('可用命令:', pluginManager.getPluginContext().getRegisteredCommands());
```

## 内置插件介绍

### 1. 文本选择插件 (text-selection)

**功能**: 提供单页和跨页文本选择功能

**使用方法**:
- **选择文本**: 鼠标拖拽选择文本
- **跨页选择**: 从一个页面拖拽到另一个页面
- **复制文本**: 选择完成后自动复制到剪贴板
- **清除选择**: 按 `Escape` 键或点击空白区域

**控制台命令**:
```javascript
// 获取文本选择插件
const textPlugin = pluginManager.getPlugin('text-selection');

// 程序化选择文本 (页面0, 字符10-50)
await textPlugin.selectText(0, 10, 0, 50);

// 开始跨页选择
textPlugin.startCrossPageSelection(0, 10);
textPlugin.updateCrossPageSelection(1, 20);
const text = await textPlugin.endCrossPageSelection();

// 清除选择
textPlugin.clearSelection();
```

**事件监听**:
```javascript
// 监听文本选择事件
pluginManager.getEventBus().on('text:selected', (event) => {
  console.log('选择了文本:', event.selection.text);
});

// 监听跨页选择事件
pluginManager.getEventBus().on('text:crossPageSelectionEnded', (event) => {
  console.log('跨页选择完成:', event.text);
});
```

## 插件安装和管理

### 查看已安装插件

```javascript
// 获取所有已注册的插件
const plugins = pluginManager.getRegisteredPlugins();
console.log('已安装插件:', plugins);

// 检查特定插件是否已安装
const isInstalled = pluginManager.isPluginRegistered('text-selection');
console.log('文本选择插件已安装:', isInstalled);
```

### 插件状态管理

```javascript
// 获取插件实例
const plugin = pluginManager.getPlugin('text-selection');

// 获取插件上下文
const context = pluginManager.getPluginContext();

// 查看已注册的命令
console.log('可用命令:', context.getRegisteredCommands());

// 查看事件监听器数量
console.log('事件监听器:', pluginManager.getEventBus().getListenerCount());

// 查看状态管理器中的数据
console.log('状态键:', pluginManager.getStateManager().getStateKeys());
```

### 手动安装插件

```javascript
// 动态安装新插件 (开发模式)
import { MyCustomPlugin } from './path/to/plugin';

const customPlugin = new MyCustomPlugin();
await pluginManager.registerPlugin(customPlugin);
```

## 常用功能使用

### 文档操作

```javascript
// 获取文档管理器
const docManager = pluginManager.getPluginContext().documentManager;

// 获取已加载的文档
const documents = docManager.getLoadedDocuments();
console.log('已加载文档:', documents);

// 检查文档是否已加载
const isLoaded = docManager.isDocumentLoaded('document-id');

// 获取文档元数据
const metadata = docManager.getLegacyMetadata('document-id');
console.log('文档信息:', metadata);
```

### 事件系统使用

```javascript
const eventBus = pluginManager.getEventBus();

// 监听文档打开事件
eventBus.on('document:opened', (event) => {
  console.log('文档已打开:', event.documentId);
});

// 监听文档关闭事件
eventBus.on('document:closed', (event) => {
  console.log('文档已关闭:', event.documentId);
});

// 监听错误事件
eventBus.on('error', (error) => {
  console.error('插件错误:', error);
});

// 发射自定义事件
eventBus.emit('my-custom-event', { data: 'some data' });
```

### 状态管理使用

```javascript
const stateManager = pluginManager.getStateManager();

// 设置状态
stateManager.setState('my-app:theme', 'dark');
stateManager.setState('my-app:language', 'zh-CN');

// 获取状态
const theme = stateManager.getState('my-app:theme');
console.log('当前主题:', theme);

// 订阅状态变化
const unsubscribe = stateManager.subscribe('my-app:theme', (newTheme) => {
  console.log('主题已更改为:', newTheme);
  // 更新UI
  document.body.className = `theme-${newTheme}`;
});

// 取消订阅
unsubscribe();
```

### 命令系统使用

```javascript
const context = pluginManager.getPluginContext();

// 执行插件命令
const result = await context.executeCommand('text-selection:select', 0, 10, 0, 50);
console.log('命令执行结果:', result);

// 批量执行命令
const commands = [
  ['text-selection:clear'],
  ['text-selection:select', 0, 0, 0, 100]
];

for (const [command, ...args] of commands) {
  try {
    await context.executeCommand(command, ...args);
  } catch (error) {
    console.error(`命令 ${command} 执行失败:`, error);
  }
}
```

## 自定义配置

### 创建配置管理

```javascript
// 创建一个简单的配置管理器
class ConfigManager {
  constructor() {
    this.stateManager = pluginManager.getStateManager();
    this.loadConfig();
  }
  
  // 加载配置
  loadConfig() {
    const saved = localStorage.getItem('pdf-viewer-config');
    const config = saved ? JSON.parse(saved) : this.getDefaultConfig();
    this.stateManager.setState('app:config', config);
  }
  
  // 保存配置
  saveConfig() {
    const config = this.stateManager.getState('app:config');
    localStorage.setItem('pdf-viewer-config', JSON.stringify(config));
  }
  
  // 默认配置
  getDefaultConfig() {
    return {
      theme: 'light',
      language: 'zh-CN',
      autoSave: true,
      textSelection: {
        highlightColor: '#0078d4',
        copyOnSelect: true
      },
      performance: {
        enableWorkers: true,
        maxConcurrency: 8
      }
    };
  }
  
  // 获取配置项
  get(key) {
    const config = this.stateManager.getState('app:config') || {};
    return key.split('.').reduce((obj, k) => obj?.[k], config);
  }
  
  // 设置配置项
  set(key, value) {
    const config = { ...this.stateManager.getState('app:config') };
    const keys = key.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, k) => obj[k] = obj[k] || {}, config);
    target[lastKey] = value;
    
    this.stateManager.setState('app:config', config);
    this.saveConfig();
  }
}

// 使用配置管理器
const config = new ConfigManager();

// 设置主题
config.set('theme', 'dark');

// 设置文本选择颜色
config.set('textSelection.highlightColor', '#ff6b35');

// 获取配置
const theme = config.get('theme');
const highlightColor = config.get('textSelection.highlightColor');
```

### 主题系统

```javascript
// 主题管理器
class ThemeManager {
  constructor() {
    this.stateManager = pluginManager.getStateManager();
    this.eventBus = pluginManager.getEventBus();
    this.init();
  }
  
  init() {
    // 监听主题变化
    this.stateManager.subscribe('app:theme', (theme) => {
      this.applyTheme(theme);
    });
    
    // 应用默认主题
    const theme = this.stateManager.getState('app:theme') || 'light';
    this.applyTheme(theme);
  }
  
  applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    
    // 发射主题变化事件
    this.eventBus.emit('theme:changed', { theme });
  }
  
  setTheme(theme) {
    this.stateManager.setState('app:theme', theme);
  }
  
  getTheme() {
    return this.stateManager.getState('app:theme') || 'light';
  }
  
  toggleTheme() {
    const current = this.getTheme();
    const newTheme = current === 'light' ? 'dark' : 'light';
    this.setTheme(newTheme);
  }
}

// CSS 主题变量
const themeStyles = `
  [data-theme="light"] {
    --bg-color: #ffffff;
    --text-color: #000000;
    --border-color: #e0e0e0;
    --accent-color: #0078d4;
  }
  
  [data-theme="dark"] {
    --bg-color: #1a1a1a;
    --text-color: #ffffff;
    --border-color: #404040;
    --accent-color: #4cc2ff;
  }
  
  body {
    background-color: var(--bg-color);
    color: var(--text-color);
    transition: background-color 0.3s, color 0.3s;
  }
`;

// 注入样式
const styleElement = document.createElement('style');
styleElement.textContent = themeStyles;
document.head.appendChild(styleElement);

// 使用主题管理器
const themeManager = new ThemeManager();

// 切换主题
themeManager.toggleTheme();
```

### 快捷键配置

```javascript
// 快捷键管理器
class ShortcutManager {
  constructor() {
    this.shortcuts = new Map();
    this.eventBus = pluginManager.getEventBus();
    this.context = pluginManager.getPluginContext();
    this.init();
  }
  
  init() {
    document.addEventListener('keydown', this.handleKeyDown.bind(this));
    this.registerDefaultShortcuts();
  }
  
  registerDefaultShortcuts() {
    // 文本选择相关
    this.register('Escape', () => {
      this.context.executeCommand('text-selection:clear');
    });
    
    this.register('Ctrl+A', () => {
      // 选择当前页面所有文本
      const docIds = this.context.documentManager.getLoadedDocuments();
      if (docIds.length > 0) {
        // 这里需要获取当前页面信息，简化示例
        this.context.executeCommand('text-selection:select', 0, 0, 0, -1);
      }
    });
    
    // 主题切换
    this.register('Ctrl+Shift+T', () => {
      this.eventBus.emit('shortcut:toggle-theme');
    });
  }
  
  register(key, handler, description = '') {
    this.shortcuts.set(key.toLowerCase(), { handler, description });
  }
  
  unregister(key) {
    this.shortcuts.delete(key.toLowerCase());
  }
  
  handleKeyDown(event) {
    const key = this.getKeyString(event);
    const shortcut = this.shortcuts.get(key);
    
    if (shortcut) {
      event.preventDefault();
      shortcut.handler(event);
    }
  }
  
  getKeyString(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.shiftKey) parts.push('Shift');
    if (event.altKey) parts.push('Alt');
    if (event.metaKey) parts.push('Meta');
    
    const key = event.key;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
      parts.push(key);
    }
    
    return parts.join('+').toLowerCase();
  }
  
  getShortcuts() {
    return Array.from(this.shortcuts.entries()).map(([key, { description }]) => ({
      key,
      description
    }));
  }
}

// 使用快捷键管理器
const shortcutManager = new ShortcutManager();

// 注册自定义快捷键
shortcutManager.register('Ctrl+F', () => {
  console.log('打开搜索功能');
  // 这里可以触发搜索插件
});

// 查看所有快捷键
console.log('已注册快捷键:', shortcutManager.getShortcuts());
```

## 故障排除

### 常见问题

#### 1. 插件加载失败

**现象**: 控制台显示插件初始化错误

**解决方法**:
```javascript
// 检查插件状态
console.log('插件状态:', pluginManager.getRegisteredPlugins());

// 查看错误详情
pluginManager.getEventBus().on('error', (error) => {
  console.error('插件错误详情:', error);
});

// 重新初始化插件系统
await pluginManager.destroy();
// 重新注册插件
```

#### 2. 命令执行失败

**现象**: `executeCommand` 抛出异常

**解决方法**:
```javascript
// 检查可用命令
const commands = pluginManager.getPluginContext().getRegisteredCommands();
console.log('可用命令:', commands);

// 安全执行命令
async function safeExecuteCommand(command, ...args) {
  try {
    return await pluginManager.getPluginContext().executeCommand(command, ...args);
  } catch (error) {
    console.error(`命令 ${command} 执行失败:`, error);
    return null;
  }
}
```

#### 3. 事件监听器不工作

**现象**: 事件监听器没有被触发

**解决方法**:
```javascript
// 检查事件监听器数量
const listenerCount = pluginManager.getEventBus().getListenerCount();
console.log('事件监听器数量:', listenerCount);

// 检查特定事件的监听器
const eventCount = pluginManager.getEventBus().getListenerCount('document:opened');
console.log('document:opened 监听器数量:', eventCount);

// 手动触发事件测试
pluginManager.getEventBus().emit('test:event', { data: 'test' });
```

#### 4. 状态管理问题

**现象**: 状态没有正确保存或更新

**解决方法**:
```javascript
// 检查状态键
const stateKeys = pluginManager.getStateManager().getStateKeys();
console.log('状态键:', stateKeys);

// 清除所有状态
pluginManager.getStateManager().clear();

// 重新设置状态
pluginManager.getStateManager().setState('test:key', 'test:value');
```

### 调试工具

#### 1. 插件调试器

```javascript
// 创建调试面板
function createDebugPanel() {
  const panel = document.createElement('div');
  panel.style.cssText = `
    position: fixed;
    top: 100px;
    right: 20px;
    width: 300px;
    max-height: 400px;
    background: rgba(0, 0, 0, 0.9);
    color: white;
    padding: 15px;
    border-radius: 8px;
    font-family: monospace;
    font-size: 12px;
    overflow-y: auto;
    z-index: 10000;
  `;
  
  const updatePanel = () => {
    const plugins = pluginManager.getRegisteredPlugins();
    const commands = pluginManager.getPluginContext().getRegisteredCommands();
    const listeners = pluginManager.getEventBus().getListenerCount();
    const stateKeys = pluginManager.getStateManager().getStateKeys();
    
    panel.innerHTML = `
      <h3>🔌 插件调试器</h3>
      <div><strong>插件 (${plugins.length}):</strong></div>
      ${plugins.map(p => `<div>• ${p.name} v${p.version}</div>`).join('')}
      
      <div style="margin-top: 10px;"><strong>命令 (${commands.length}):</strong></div>
      ${commands.map(c => `<div>• ${c}</div>`).join('')}
      
      <div style="margin-top: 10px;"><strong>事件监听器:</strong> ${listeners}</div>
      <div style="margin-top: 10px;"><strong>状态键:</strong> ${stateKeys.length}</div>
      
      <button onclick="this.parentElement.remove()" style="
        margin-top: 10px;
        padding: 5px 10px;
        background: #ff4444;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      ">关闭</button>
    `;
  };
  
  updatePanel();
  document.body.appendChild(panel);
  
  // 定期更新
  const interval = setInterval(updatePanel, 2000);
  panel.addEventListener('remove', () => clearInterval(interval));
}

// 创建调试面板
createDebugPanel();
```

#### 2. 性能监控

```javascript
// 性能监控器
class PerformanceMonitor {
  constructor() {
    this.metrics = new Map();
    this.eventBus = pluginManager.getEventBus();
    this.init();
  }
  
  init() {
    // 监控命令执行时间
    const originalExecuteCommand = pluginManager.getPluginContext().executeCommand;
    pluginManager.getPluginContext().executeCommand = async (command, ...args) => {
      const start = performance.now();
      try {
        const result = await originalExecuteCommand.call(
          pluginManager.getPluginContext(), 
          command, 
          ...args
        );
        const duration = performance.now() - start;
        this.recordMetric(`command:${command}`, duration);
        return result;
      } catch (error) {
        const duration = performance.now() - start;
        this.recordMetric(`command:${command}:error`, duration);
        throw error;
      }
    };
  }
  
  recordMetric(name, value) {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    this.metrics.get(name).push({
      value,
      timestamp: Date.now()
    });
    
    // 保持最近100条记录
    const records = this.metrics.get(name);
    if (records.length > 100) {
      records.shift();
    }
  }
  
  getMetrics() {
    const result = {};
    for (const [name, records] of this.metrics) {
      const values = records.map(r => r.value);
      result[name] = {
        count: values.length,
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        recent: values.slice(-10)
      };
    }
    return result;
  }
  
  printReport() {
    const metrics = this.getMetrics();
    console.group('📊 性能报告');
    for (const [name, stats] of Object.entries(metrics)) {
      console.log(`${name}:`, {
        '平均耗时': `${stats.avg.toFixed(2)}ms`,
        '最小耗时': `${stats.min.toFixed(2)}ms`,
        '最大耗时': `${stats.max.toFixed(2)}ms`,
        '调用次数': stats.count
      });
    }
    console.groupEnd();
  }
}

// 启用性能监控
const perfMonitor = new PerformanceMonitor();

// 定期打印报告
setInterval(() => {
  perfMonitor.printReport();
}, 30000); // 每30秒
```

### 重置和恢复

```javascript
// 完全重置插件系统
async function resetPluginSystem() {
  console.log('🔄 重置插件系统...');
  
  try {
    // 销毁当前插件系统
    await pluginManager.destroy();
    
    // 清理本地存储
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith('pdf-viewer-')) {
        localStorage.removeItem(key);
      }
    });
    
    // 重新初始化
    location.reload(); // 简单的重载页面
    
  } catch (error) {
    console.error('重置失败:', error);
  }
}

// 备份和恢复配置
function backupConfig() {
  const config = {
    plugins: pluginManager.getRegisteredPlugins(),
    states: {},
    timestamp: Date.now()
  };
  
  // 备份所有状态
  const stateKeys = pluginManager.getStateManager().getStateKeys();
  stateKeys.forEach(key => {
    config.states[key] = pluginManager.getStateManager().getState(key);
  });
  
  const backup = JSON.stringify(config, null, 2);
  
  // 下载备份文件
  const blob = new Blob([backup], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pdf-viewer-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// 恢复配置
async function restoreConfig(configJson) {
  try {
    const config = JSON.parse(configJson);
    
    // 恢复状态
    for (const [key, value] of Object.entries(config.states)) {
      pluginManager.getStateManager().setState(key, value);
    }
    
    console.log('✅ 配置恢复成功');
  } catch (error) {
    console.error('❌ 配置恢复失败:', error);
  }
}
```

这份使用指南为用户提供了完整的插件系统使用方法，从基础操作到高级配置，帮助用户充分利用插件系统的功能。 