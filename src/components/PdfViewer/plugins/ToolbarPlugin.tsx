import React from "react";
import { PdfMetadata } from "@/PdfViewer/types/pdf";

interface ToolbarPluginProps {
  pdfMetadata: PdfMetadata | null;
  isLoading: boolean;
  scale: number;
  renderedPagesCount: number;
  onOpenPdf: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomToFit?: () => void;
  onClosePdf?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export const ToolbarPlugin: React.FC<ToolbarPluginProps> = ({
  pdfMetadata,
  isLoading,
  scale,
  renderedPagesCount,
  onOpenPdf,
  onZoomIn,
  onZoomOut,
  onZoomToFit,
  onClosePdf,
  className,
  style,
}) => {
  const defaultStyle: React.CSSProperties = {
    height: "60px",
    background: "rgb(245 245 245 / 1)",
    border: "1px solid rgb(221 221 221 / 1)",
    display: "flex",
    alignItems: "center",
    padding: "0 16px",
    gap: "12px",
    ...style,
  };

  const buttonBaseStyle: React.CSSProperties = {
    padding: "8px 16px",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: "500",
    transition: "all 0.2s ease",
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...buttonBaseStyle,
    background: "rgb(59 130 246 / 1)",
    color: "white",
  };

  const secondaryButtonStyle: React.CSSProperties = {
    ...buttonBaseStyle,
    background: "rgb(229 231 235 / 1)",
    color: "rgb(55 65 81 / 1)",
  };

  const iconButtonStyle: React.CSSProperties = {
    ...buttonBaseStyle,
    padding: "8px",
    minWidth: "36px",
    background: "rgb(229 231 235 / 1)",
    color: "rgb(55 65 81 / 1)",
  };

  return (
    <div className={className} style={defaultStyle}>
      {/* 文件操作 */}
      <button onClick={onOpenPdf} style={primaryButtonStyle} disabled={isLoading}>
        {isLoading ? "加载中..." : "打开PDF"}
      </button>

      {onClosePdf && pdfMetadata && (
        <button onClick={onClosePdf} style={secondaryButtonStyle}>
          关闭
        </button>
      )}

      {/* 分隔线 */}
      {pdfMetadata && (
        <div style={{ width: "1px", height: "24px", background: "rgb(209 213 219 / 1)", margin: "0 8px" }} />
      )}

      {/* PDF信息 */}
      {pdfMetadata && (
        <span style={{ color: "rgb(107 114 128 / 1)", fontSize: "14px" }}>{pdfMetadata.total_pages} 页</span>
      )}

      {/* 缩放控制 */}
      {pdfMetadata && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <button onClick={onZoomOut} style={iconButtonStyle} title="缩小">
              −
            </button>
            <span
              style={{
                minWidth: "60px",
                textAlign: "center",
                fontSize: "14px",
                color: "rgb(55 65 81 / 1)",
              }}
            >
              {Math.round(scale * 100)}%
            </span>
            <button onClick={onZoomIn} style={iconButtonStyle} title="放大">
              +
            </button>
          </div>

          {onZoomToFit && (
            <button onClick={onZoomToFit} style={secondaryButtonStyle} title="适合页面">
              适合
            </button>
          )}
        </>
      )}

      {/* 状态信息 */}
      {pdfMetadata && (
        <>
          <div style={{ flex: 1 }} />
          <span
            style={{
              color: "rgb(107 114 128 / 1)",
              fontSize: "12px",
              background: "rgb(243 244 246 / 1)",
              padding: "4px 8px",
              borderRadius: "4px",
            }}
          >
            单Canvas渲染 ({renderedPagesCount} 页已渲染)
          </span>
        </>
      )}
    </div>
  );
};
