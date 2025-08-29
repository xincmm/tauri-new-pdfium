import { useState } from 'react';
import { PdfViewer } from './components/PdfViewer/PdfViewer';
import { PdfViewerV2 } from './components/PdfViewer/PdfViewerV2';
import './App.css';

function App() {
  const [useV2, setUseV2] = useState(false);

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
        fontSize: '12px'
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={useV2}
            onChange={(e) => setUseV2(e.target.checked)}
          />
          使用插件架构版本 {useV2 ? '(V2)' : '(V1)'}
        </label>
      </div>

      {/* 根据选择渲染不同版本 */}
      {useV2 ? <PdfViewerV2 /> : <PdfViewer />}
    </div>
  );
}

export default App;
