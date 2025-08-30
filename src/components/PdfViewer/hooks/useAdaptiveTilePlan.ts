import { useMemo } from 'react';

export interface AdaptiveTilePlanInput {
  scale: number;
  pageWidth: number;
  pageHeight: number;
  tileSize: number;
  viewportTop: number; // container scrollTop
  viewportHeight: number;
  pageTopAbs: number; // absolute top of page within scroll area
}

export interface TileCoord { tx: number; ty: number; }

export interface AdaptiveTilePlanResult {
  tilesToLoad: TileCoord[];
  tyRange: [number, number];
  tilesX: number;
  tilesY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function useAdaptiveTilePlan(input: AdaptiveTilePlanInput): AdaptiveTilePlanResult {
  const { scale, pageWidth, pageHeight, tileSize, viewportTop, viewportHeight, pageTopAbs } = input;

  return useMemo(() => {
    const tilesX = Math.max(1, Math.ceil(pageWidth / tileSize));
    const tilesY = Math.max(1, Math.ceil(pageHeight / tileSize));

    // Compute page-local viewport range
    const pageViewportTop = viewportTop - pageTopAbs;
    const pageViewportBottom = pageViewportTop + viewportHeight;

    const clippedTop = clamp(pageViewportTop, 0, pageHeight);
    const clippedBottom = clamp(pageViewportBottom, 0, pageHeight);

    let startTy = 0;
    let endTy = tilesY - 1;

    if (scale > 4) {
      // Row-based loading: only rows intersecting the viewport, with +/-1 row margin
      const top = clippedTop - tileSize;
      const bottom = clippedBottom + tileSize;
      startTy = clamp(Math.floor(top / tileSize), 0, tilesY - 1);
      endTy = clamp(Math.floor((bottom - 1) / tileSize), 0, tilesY - 1);
    } else if (scale > 2.5) {
      // Half-page band around the viewport center
      const centerY = (clippedTop + clippedBottom) / 2;
      const halfBand = pageHeight * 0.25; // total height = 0.5 * pageHeight
      const top = centerY - halfBand;
      const bottom = centerY + halfBand;
      startTy = clamp(Math.floor(top / tileSize), 0, tilesY - 1);
      endTy = clamp(Math.floor((bottom - 1) / tileSize), 0, tilesY - 1);
    } else {
      // Full page
      startTy = 0;
      endTy = tilesY - 1;
    }

    // Generate tile coords for the target rows
    const tilesToLoad: TileCoord[] = [];
    for (let ty = startTy; ty <= endTy; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        tilesToLoad.push({ tx, ty });
      }
    }

    return { tilesToLoad, tyRange: [startTy, endTy], tilesX, tilesY };
  }, [scale, pageWidth, pageHeight, tileSize, viewportTop, viewportHeight, pageTopAbs]);
} 