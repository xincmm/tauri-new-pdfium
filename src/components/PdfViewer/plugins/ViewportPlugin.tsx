import React from "react";
import { PdfMetadata } from "@/PdfViewer/types/pdf";

interface ViewportPluginProps {
  pdfMetadata: PdfMetadata | null;
  totalHeight: number;
  totalWidth: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  toolbarHeight?: number;
}

export const ViewportPlugin: React.FC<ViewportPluginProps> = ({
  pdfMetadata,
  totalHeight,
  totalWidth,
  containerRef,
  canvasRef,
  onScroll,
  children,
  className,
  style,
  toolbarHeight = 60,
}) => {
  const containerStyle: React.CSSProperties = {
    flex: 1,
    overflow: "auto",
    background: "rgb(232 232 232 / 1)",
    position: "relative",
    ...style,
  };

  const placeholderStyle: React.CSSProperties = {
    height: totalHeight,
    width: Math.max(totalWidth, containerRef.current?.clientWidth || 0),
    position: "relative",
    margin: "0 auto",
  };

  const canvasStyle: React.CSSProperties = {
    position: "fixed",
    top: `${toolbarHeight}px`,
    left: 0,
    pointerEvents: "none" as const,
    zIndex: 1,
    imageRendering: "crisp-edges" as const,
  };

  const emptyStateStyle: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    textAlign: "center" as const,
    color: "rgb(107 114 128 / 1)",
  };

  return (
    <div className={className} style={containerStyle} onScroll={onScroll} ref={containerRef}>
      {/* 占位容器用于滚动 */}
      <div style={placeholderStyle}>
        {/* 单个 Canvas 覆盖整个可视区域 */}
        <canvas ref={canvasRef} style={canvasStyle} />

        {/* 额外的子组件（比如文本层、注释层等） */}
        {children}
      </div>

      {/* 空状态提示 */}
      {!pdfMetadata && (
        <div style={emptyStateStyle}>
          <h3
            style={{
              margin: "0 0 12px 0",
              fontSize: "18px",
              fontWeight: "600",
              color: "rgb(55 65 81 / 1)",
            }}
          >
            单Canvas PDF渲染器
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: "14px",
              color: "rgb(107 114 128 / 1)",
            }}
          >
            点击"打开PDF"开始测试高性能渲染
          </p>
        </div>
      )}
    </div>
  );
};
