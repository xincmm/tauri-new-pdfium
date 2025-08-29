import { useState } from 'react';
import { PdfViewer } from './components/PdfViewer/PdfViewer';
import { PdfViewerV2 } from './components/PdfViewer/PdfViewerV2';
import { SimpleViewer } from './components/PdfViewer/SimpleViewer';
import './App.css';

function App() {
  const [viewerType, setViewerType] = useState<'v1' | 'v2' | 'simple'>('simple'); // 默认使用简单测试版本

  return (
    <div className="App">
      {/* 版本切换器 */}
      <div style={{
        position: 'fixed',
        top: '10px',
        right: '10px',
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.8)',
        color: 'white',
        padding: '8px 12px',
        borderRadius: '4px',
        fontSize: '12px',
        display: 'flex',
        gap: '8px',
      }}>
        <button 
          onClick={() => setViewerType('simple')}
          style={{
            background: viewerType === 'simple' ? '#007acc' : 'transparent',
            color: 'white',
            border: '1px solid #555',
            padding: '4px 8px',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '11px',
          }}
        >
          简单测试
        </button>
        <button 
          onClick={() => setViewerType('v2')}
          style={{
            background: viewerType === 'v2' ? '#007acc' : 'transparent',
            color: 'white',
            border: '1px solid #555',
            padding: '4px 8px',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '11px',
          }}
        >
          V2插件
        </button>
        <button 
          onClick={() => setViewerType('v1')}
          style={{
            background: viewerType === 'v1' ? '#007acc' : 'transparent',
            color: 'white',
            border: '1px solid #555',
            padding: '4px 8px',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '11px',
          }}
        >
          V1基础
        </button>
      </div>

      {/* 渲染对应的版本 */}
      {viewerType === 'simple' && <SimpleViewer />}
      {viewerType === 'v2' && <PdfViewerV2 />}
      {viewerType === 'v1' && <PdfViewer />}
    </div>
  );
}

export default App;
