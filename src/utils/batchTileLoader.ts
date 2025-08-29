import { invoke } from '@tauri-apps/api/core';
import { TileRequest, TileData, BatchTileResult, TILE_SIZE } from '../types/pdf';

// 批量瓦片加载器
export class BatchTileLoader {
  private loadingBatches = new Set<string>();

  // 将传统瓦片信息转换为新的TileRequest格式
  private convertToTileRequest(
    _pdfId: string,
    pageIndex: number, 
    tx: number,
    ty: number,
    scale: number,
    dpr: number,
    _pageWidth: number,
    _pageHeight: number
  ): TileRequest {
    const tileSize = TILE_SIZE;
    
    // 正确的坐标转换：屏幕像素 → PDF points
    // 屏幕上瓦片的像素坐标
    const tilePixelX = tx * tileSize;
    const tilePixelY = ty * tileSize;
    
    // 转换为PDF points坐标 (72 points = 96 pixels at 100% scale)
    // 公式: pixels * 72 / 96 / scale
    const pointsPerPixel = 72.0 / 96.0 / scale;
    
    const tileRequest = {
      page_index: pageIndex,
      rect_x: tilePixelX * pointsPerPixel,
      rect_y: tilePixelY * pointsPerPixel,
      rect_width: tileSize * pointsPerPixel,
      rect_height: tileSize * pointsPerPixel,
      scale_factor: scale,
      dpr: dpr,
    };
    
    // 添加调试日志（仅第一个瓦片）
    if (tx === 0 && ty === 0) {
      console.log(`🔧 瓦片坐标转换 (tx=${tx}, ty=${ty}):`, {
        屏幕像素坐标: `${tilePixelX}x${tilePixelY}`,
        转换因子: pointsPerPixel.toFixed(4),
        PDF坐标: `${tileRequest.rect_x.toFixed(1)}x${tileRequest.rect_y.toFixed(1)}`,
        瓦片尺寸_points: `${tileRequest.rect_width.toFixed(1)}x${tileRequest.rect_height.toFixed(1)}`,
        缩放参数: `scale=${scale}, dpr=${dpr}`
      });
    }
    
    return tileRequest;
  }

  // 解析后端返回的打包字节数据
  private parsePackedTileData(data: Uint8Array): TileData[] {
    const tiles: TileData[] = [];
    let offset = 0;

    // 创建一个DataView来读取整个数据
    const view = new DataView(data.buffer);

    // 读取瓦片数量
    const tileCount = view.getUint32(offset, true); // little-endian
    offset += 4;

    console.log(`📦 解析批量瓦片数据: ${tileCount} 个瓦片，总大小 ${data.length} bytes`);

    // 解析每个瓦片
    for (let i = 0; i < tileCount; i++) {
      // 检查边界
      if (offset + 4 > data.length) {
        console.error(`数据越界：尝试读取瓦片长度时，offset=${offset}, dataLength=${data.length}`);
        break;
      }

      // 读取瓦片数据长度
      const tileLength = view.getUint32(offset, true); // little-endian
      offset += 4;

      // 检查瓦片数据边界
      if (offset + tileLength > data.length) {
        console.error(`数据越界：尝试读取瓦片数据时，offset=${offset}, tileLength=${tileLength}, dataLength=${data.length}`);
        break;
      }

      // 读取瓦片数据
      const tileData = data.slice(offset, offset + tileLength);
      offset += tileLength;

      console.log(`解析瓦片 ${i}: 大小=${tileLength} bytes`);

      tiles.push({
        data: tileData,
        width: 0, // 实际尺寸需要从WebP解码后获得
        height: 0,
        key: `tile_${i}`, // 临时键，需要外部设置正确的键
      });
    }

    return tiles;
  }

  // 批量渲染瓦片
  async renderTilesBatch(requests: {
    pdfId: string;
    pageIndex: number;
    tx: number;
    ty: number;
    scale: number;
    dpr: number;
    pageWidth: number;
    pageHeight: number;
    tileKey: string;
  }[]): Promise<BatchTileResult> {
    // 生成批次ID
    const batchId = requests.map(r => r.tileKey).join('|');
    
    if (this.loadingBatches.has(batchId)) {
      throw new Error('Batch already loading');
    }

    this.loadingBatches.add(batchId);

    try {
      // 转换为后端请求格式
      const tileRequests: TileRequest[] = requests.map(req =>
        this.convertToTileRequest(
          req.pdfId,
          req.pageIndex,
          req.tx,
          req.ty,
          req.scale,
          req.dpr,
          req.pageWidth,
          req.pageHeight
        )
      );

      console.log(`🚀 开始批量渲染: ${tileRequests.length} 个瓦片`);

      // 调用后端渲染命令
      const rawData = await invoke<number[]>('render_tiles_batch', { 
        requests: tileRequests 
      });

      // 转换为 Uint8Array
      const packedData = new Uint8Array(rawData);
      
      // 解析返回数据
      const tiles = this.parsePackedTileData(packedData);

      // 设置正确的瓦片键
      tiles.forEach((tile, index) => {
        tile.key = requests[index].tileKey;
      });

      console.log(`✅ 批量渲染完成: ${tiles.length} 个瓦片`);

      return {
        tiles,
        totalBytes: packedData.length,
        tileCount: tiles.length,
      };

    } finally {
      this.loadingBatches.delete(batchId);
    }
  }

  // 渲染单个瓦片（兼容性方法）
  async renderSingleTile(
    pdfId: string,
    pageIndex: number,
    tx: number,
    ty: number,
    scale: number,
    dpr: number,
    pageWidth: number,
    pageHeight: number,
    tileKey: string
  ): Promise<TileData> {
    const result = await this.renderTilesBatch([{
      pdfId,
      pageIndex,
      tx,
      ty,
      scale,
      dpr,
      pageWidth,
      pageHeight,
      tileKey,
    }]);

    return result.tiles[0];
  }
}

// 全局批量瓦片加载器实例
export const batchTileLoader = new BatchTileLoader(); 