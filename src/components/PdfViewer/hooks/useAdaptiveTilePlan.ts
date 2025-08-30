import { useMemo } from "react";

export interface AdaptiveTilePlanInput {
  scale: number;
  pageWidth: number;
  pageHeight: number;
  tileSize: number;
  viewportTop: number; // container scrollTop
  viewportHeight: number;
  pageTopAbs: number; // absolute top of page within scroll area
  viewportVelocityPxPerMs: number;
  scrollDirection: -1 | 0 | 1;
}

export interface TileCoord {
  tx: number;
  ty: number;
}

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
  const {
    scale,
    pageWidth,
    pageHeight,
    tileSize,
    viewportTop,
    viewportHeight,
    pageTopAbs,
    viewportVelocityPxPerMs,
    scrollDirection,
  } = input;

  return useMemo(() => {
    const tilesX = Math.max(1, Math.ceil(pageWidth / tileSize));
    const tilesY = Math.max(1, Math.ceil(pageHeight / tileSize));

    // Compute page-local viewport range
    const pageViewportTop = viewportTop - pageTopAbs;
    const pageViewportBottom = pageViewportTop + viewportHeight;

    const clippedTop = clamp(pageViewportTop, 0, pageHeight);
    const clippedBottom = clamp(pageViewportBottom, 0, pageHeight);

    // Speed classes
    const v = Math.max(0, viewportVelocityPxPerMs || 0);
    const speedClass: "slow" | "medium" | "fast" = v < 0.25 ? "slow" : v <= 0.75 ? "medium" : "fast";
    const dir = scrollDirection || 0;

    let startTy = 0;
    let endTy = tilesY - 1;

    if (scale > 4) {
      // Row-based loading: only rows intersecting the viewport, with directional lead and margins
      const baseTop = clippedTop;
      const baseBottom = clippedBottom;
      let s = clamp(Math.floor(baseTop / tileSize), 0, tilesY - 1);
      let e = clamp(Math.floor((baseBottom - 1) / tileSize), 0, tilesY - 1);

      const marginRows = speedClass === "slow" ? 2 : 1;
      const leadRows = speedClass === "slow" ? 2 : speedClass === "medium" ? 3 : 4;

      if (dir > 0) {
        e += leadRows;
      } else if (dir < 0) {
        s -= leadRows;
      }

      s -= marginRows;
      e += marginRows;

      startTy = clamp(s, 0, tilesY - 1);
      endTy = clamp(e, 0, tilesY - 1);
    } else if (scale > 2.5) {
      // Half-page band around the (directionally shifted) viewport center
      const halfBand = pageHeight * 0.25; // total band height = 0.5 * pageHeight
      const offsetFactor = speedClass === "slow" ? 0.15 : speedClass === "medium" ? 0.25 : 0.35;
      const centerBase = (clippedTop + clippedBottom) / 2;
      const centerShifted = clamp(centerBase + dir * (offsetFactor * pageHeight), 0, pageHeight);

      const top = centerShifted - halfBand;
      const bottom = centerShifted + halfBand;

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
  }, [
    scale,
    pageWidth,
    pageHeight,
    tileSize,
    viewportTop,
    viewportHeight,
    pageTopAbs,
    viewportVelocityPxPerMs,
    scrollDirection,
  ]);
}
