// 插件系统核心实现
import { ReactPDF } from '@/PdfViewer/types/pdf-core';
import { documentManager } from './DocumentManager';

/**
 * 简单的事件总线实现
 */
export class EventBus implements ReactPDF.EventBus {
  private listeners = new Map<string, Set<Function>>();

  on<T = any>(event: string, handler: (data: T) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: Function): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(handler);
      if (eventListeners.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  emit<T = any>(event: string, data: T): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      // 异步执行所有监听器，避免阻塞
      setTimeout(() => {
        eventListeners.forEach(handler => {
          try {
            handler(data);
          } catch (error) {
            console.error(`Error in event handler for ${event}:`, error);
          }
        });
      }, 0);
    }
  }

  /**
   * 获取事件监听器数量（调试用）
   */
  getListenerCount(event?: string): number {
    if (event) {
      return this.listeners.get(event)?.size || 0;
    }
    return Array.from(this.listeners.values()).reduce((total, set) => total + set.size, 0);
  }

  /**
   * 清理所有监听器
   */
  clear(): void {
    this.listeners.clear();
  }
}

/**
 * 状态管理器实现
 */
export class StateManager implements ReactPDF.StateManager {
  private state = new Map<string, any>();
  private subscribers = new Map<string, Set<(value: any) => void>>();

  getState<T = any>(key: string): T | undefined {
    return this.state.get(key);
  }

  setState<T = any>(key: string, value: T): void {
    const oldValue = this.state.get(key);
    this.state.set(key, value);

    // 通知订阅者
    const keySubscribers = this.subscribers.get(key);
    if (keySubscribers && oldValue !== value) {
      keySubscribers.forEach(callback => {
        try {
          callback(value);
        } catch (error) {
          console.error(`Error in state subscriber for ${key}:`, error);
        }
      });
    }
  }

  subscribe<T = any>(key: string, callback: (value: T) => void): () => void {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key)!.add(callback);

    // 立即调用一次回调，传入当前值
    const currentValue = this.state.get(key);
    if (currentValue !== undefined) {
      try {
        callback(currentValue);
      } catch (error) {
        console.error(`Error in initial state callback for ${key}:`, error);
      }
    }

    // 返回取消订阅函数
    return () => {
      const keySubscribers = this.subscribers.get(key);
      if (keySubscribers) {
        keySubscribers.delete(callback);
        if (keySubscribers.size === 0) {
          this.subscribers.delete(key);
        }
      }
    };
  }

  /**
   * 清理所有状态和订阅
   */
  clear(): void {
    this.state.clear();
    this.subscribers.clear();
  }

  /**
   * 获取所有状态键（调试用）
   */
  getStateKeys(): string[] {
    return Array.from(this.state.keys());
  }
}

/**
 * 插件上下文实现
 */
export class PluginContext implements ReactPDF.PluginContext {
  private commands = new Map<string, ReactPDF.CommandHandler>();

  constructor(
    public documentManager: ReactPDF.DocumentManager,
    public eventBus: ReactPDF.EventBus,
    public stateManager: ReactPDF.StateManager
  ) {}

  registerCommand(name: string, handler: ReactPDF.CommandHandler): void {
    if (this.commands.has(name)) {
      console.warn(`Command ${name} is already registered, overriding`);
    }
    this.commands.set(name, handler);
  }

  unregisterCommand(name: string): void {
    this.commands.delete(name);
  }

  /**
   * 执行命令
   */
  async executeCommand(name: string, ...args: any[]): Promise<any> {
    const handler = this.commands.get(name);
    if (!handler) {
      throw new Error(`Command ${name} not found`);
    }
    return await handler(...args);
  }

  /**
   * 获取已注册的命令列表（调试用）
   */
  getRegisteredCommands(): string[] {
    return Array.from(this.commands.keys());
  }

  /**
   * 清理所有命令
   */
  clear(): void {
    this.commands.clear();
  }
}

/**
 * 插件管理器
 */
export class PluginManager {
  private plugins = new Map<string, ReactPDF.Plugin>();
  private pluginContext: PluginContext;
  private eventBus: EventBus;
  private stateManager: StateManager;

  constructor() {
    this.eventBus = new EventBus();
    this.stateManager = new StateManager();
    this.pluginContext = new PluginContext(
      documentManager,
      this.eventBus,
      this.stateManager
    );
  }

  /**
   * 注册插件
   */
  async registerPlugin(plugin: ReactPDF.Plugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin ${plugin.name} is already registered`);
    }

    // 检查依赖
    if (plugin.dependencies) {
      for (const dep of plugin.dependencies) {
        if (!this.plugins.has(dep)) {
          throw new Error(`Plugin ${plugin.name} depends on ${dep}, but it's not registered`);
        }
      }
    }

    try {
      await plugin.initialize(this.pluginContext);
      this.plugins.set(plugin.name, plugin);
      
      this.eventBus.emit('plugin:registered', {
        name: plugin.name,
        version: plugin.version
      });
      
      console.log(`Plugin ${plugin.name} v${plugin.version} registered successfully`);
    } catch (error) {
      console.error(`Failed to initialize plugin ${plugin.name}:`, error);
      throw error;
    }
  }

  /**
   * 注销插件
   */
  async unregisterPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} is not registered`);
    }

    // 检查是否有其他插件依赖于此插件
    const dependents = Array.from(this.plugins.values()).filter(p => 
      p.dependencies?.includes(name)
    );
    
    if (dependents.length > 0) {
      const dependentNames = dependents.map(p => p.name).join(', ');
      throw new Error(`Cannot unregister plugin ${name}: it is required by ${dependentNames}`);
    }

    try {
      await plugin.destroy();
      this.plugins.delete(name);
      
      this.eventBus.emit('plugin:unregistered', { name });
      
      console.log(`Plugin ${name} unregistered successfully`);
    } catch (error) {
      console.error(`Failed to destroy plugin ${name}:`, error);
      throw error;
    }
  }

  /**
   * 获取插件
   */
  getPlugin<T extends ReactPDF.Plugin = ReactPDF.Plugin>(name: string): T | undefined {
    return this.plugins.get(name) as T;
  }

  /**
   * 检查插件是否已注册
   */
  isPluginRegistered(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * 获取所有已注册的插件
   */
  getRegisteredPlugins(): Array<{ name: string; version: string; dependencies?: string[] }> {
    return Array.from(this.plugins.values()).map(plugin => ({
      name: plugin.name,
      version: plugin.version,
      dependencies: plugin.dependencies
    }));
  }

  /**
   * 获取事件总线（供外部使用）
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * 获取状态管理器（供外部使用）
   */
  getStateManager(): StateManager {
    return this.stateManager;
  }

  /**
   * 获取插件上下文（供外部使用）
   */
  getPluginContext(): PluginContext {
    return this.pluginContext;
  }

  /**
   * 清理所有插件和资源
   */
  async destroy(): Promise<void> {
    // 按依赖关系逆序销毁插件
    const plugins = Array.from(this.plugins.values());
    const sortedPlugins = this.topologicalSort(plugins).reverse();

    for (const plugin of sortedPlugins) {
      try {
        await plugin.destroy();
      } catch (error) {
        console.error(`Failed to destroy plugin ${plugin.name}:`, error);
      }
    }

    this.plugins.clear();
    this.pluginContext.clear();
    this.eventBus.clear();
    this.stateManager.clear();
  }

  /**
   * 拓扑排序插件（处理依赖关系）
   */
  private topologicalSort(plugins: ReactPDF.Plugin[]): ReactPDF.Plugin[] {
    const sorted: ReactPDF.Plugin[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (plugin: ReactPDF.Plugin) => {
      if (visiting.has(plugin.name)) {
        throw new Error(`Circular dependency detected involving plugin ${plugin.name}`);
      }
      if (visited.has(plugin.name)) {
        return;
      }

      visiting.add(plugin.name);

      if (plugin.dependencies) {
        for (const depName of plugin.dependencies) {
          const dep = plugins.find(p => p.name === depName);
          if (dep) {
            visit(dep);
          }
        }
      }

      visiting.delete(plugin.name);
      visited.add(plugin.name);
      sorted.push(plugin);
    };

    for (const plugin of plugins) {
      visit(plugin);
    }

    return sorted;
  }
}

// 全局插件管理器实例
export const pluginManager = new PluginManager(); 