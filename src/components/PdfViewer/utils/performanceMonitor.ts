// 瓦片加载性能监控工具
export interface TileLoadMetrics {
  tileKey: string;
  networkTime: number;
  blobTime: number;
  bitmapTime: number;
  totalFrontendTime: number;
  serverTiming?: {
    queue?: number;
    setup?: number;
    raster?: number;
    pack?: number;
    encode?: number;
    write?: number;
    total?: number;
    [key: string]: number | undefined;
  };
  pixelInfo?: {
    width: number;
    height: number;
  };
  timestamp: number;
  isPreload: boolean;
}

class PerformanceMonitor {
  private metrics: TileLoadMetrics[] = [];
  private maxMetrics = 100; // 最多保留100个记录

  // 记录瓦片加载性能
  recordTileLoad(metrics: TileLoadMetrics) {
    this.metrics.push(metrics);

    // 保持数组大小在限制内
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }
  }

  // 解析Server-Timing头
  parseServerTiming(serverTimingHeader: string | null) {
    if (!serverTimingHeader) return undefined;

    const timing = {
      queue: 0,
      setup: 0,
      raster: 0,
      pack: 0,
      encode: 0,
      total: 0,
    };

    // 解析格式: "queue;dur=0.12, setup;dur=1.23, raster;dur=100.00, pack;dur=2.34, encode;dur=50.12, total;dur=153.69"
    const entries = serverTimingHeader.split(",");
    for (const entry of entries) {
      const trimmed = entry.trim();
      const [name, durPart] = trimmed.split(";dur=");
      if (name && durPart) {
        const duration = Number.parseFloat(durPart);
        if (!Number.isNaN(duration)) {
          switch (name.trim()) {
            case "queue":
              timing.queue = duration;
              break;
            case "setup":
              timing.setup = duration;
              break;
            case "raster":
              timing.raster = duration;
              break;
            case "pack":
              timing.pack = duration;
              break;
            case "encode":
              timing.encode = duration;
              break;
            case "total":
              timing.total = duration;
              break;
          }
        }
      }
    }

    return timing;
  }

  // 解析X-Pixels头
  parsePixelInfo(pixelHeader: string | null) {
    if (!pixelHeader) return undefined;

    const match = pixelHeader.match(/(\d+)x(\d+)/);
    if (match) {
      return {
        width: Number.parseInt(match[1]),
        height: Number.parseInt(match[2]),
      };
    }
    return undefined;
  }

  // 获取最近的性能统计
  getRecentStats(count = 10) {
    const recent = this.metrics.slice(-count);

    if (recent.length === 0) {
      return {
        count: 0,
        avgNetworkTime: 0,
        avgBlobTime: 0,
        avgBitmapTime: 0,
        avgTotalFrontend: 0,
        avgServerTotal: 0,
        avgServerRender: 0,
      };
    }

    const sum = recent.reduce(
      (acc, metric) => ({
        networkTime: acc.networkTime + metric.networkTime,
        blobTime: acc.blobTime + metric.blobTime,
        bitmapTime: acc.bitmapTime + metric.bitmapTime,
        totalFrontendTime: acc.totalFrontendTime + metric.totalFrontendTime,
        serverTotal: acc.serverTotal + (metric.serverTiming?.total || 0),
        serverRender: acc.serverRender + (metric.serverTiming?.raster || 0),
        serverEncode: acc.serverEncode + (metric.serverTiming?.encode || 0),
      }),
      {
        networkTime: 0,
        blobTime: 0,
        bitmapTime: 0,
        totalFrontendTime: 0,
        serverTotal: 0,
        serverRender: 0,
        serverEncode: 0,
      },
    );

    return {
      count: recent.length,
      avgNetworkTime: sum.networkTime / recent.length,
      avgBlobTime: sum.blobTime / recent.length,
      avgBitmapTime: sum.bitmapTime / recent.length,
      avgTotalFrontend: sum.totalFrontendTime / recent.length,
      avgServerTotal: sum.serverTotal / recent.length,
      avgServerRender: sum.serverRender / recent.length,
      avgServerEncode: sum.serverEncode / recent.length,
    };
  }

  // 获取性能瓶颈分析
  getBottleneckAnalysis() {
    const stats = this.getRecentStats(20);

    const bottlenecks: string[] = [];

    if (stats.avgNetworkTime > 100) {
      bottlenecks.push(`网络延迟高 (${stats.avgNetworkTime.toFixed(1)}ms)`);
    }

    if (stats.avgServerRender > 200) {
      bottlenecks.push(`服务端渲染慢 (${stats.avgServerRender.toFixed(1)}ms)`);
    }

    if (stats.avgBitmapTime > 50) {
      bottlenecks.push(`ImageBitmap创建慢 (${stats.avgBitmapTime.toFixed(1)}ms)`);
    }

    if (stats.avgBlobTime > 20) {
      bottlenecks.push(`Blob转换慢 (${stats.avgBlobTime.toFixed(1)}ms)`);
    }

    return {
      stats,
      bottlenecks,
      recommendation: this.getRecommendation(stats, bottlenecks),
    };
  }

  private getRecommendation(stats: any, bottlenecks: string[]) {
    if (bottlenecks.length === 0) {
      return "性能良好 ✅";
    }

    if (stats.avgServerRender > stats.avgNetworkTime) {
      return "建议优化服务端渲染性能";
    }
    if (stats.avgNetworkTime > 100) {
      return "建议检查网络连接或启用更积极的缓存策略";
    }
    if (stats.avgBitmapTime > 50) {
      return "建议检查图片解码性能，可能需要降低图片质量";
    }
    return "建议检查整体系统负载";
  }

  // 清空统计数据
  clear() {
    this.metrics = [];
  }
}

// 全局性能监控器实例
export const performanceMonitor = new PerformanceMonitor();
