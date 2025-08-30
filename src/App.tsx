import "./App.css";
// import { PdfViewer } from './components/PdfViewer/PdfViewer';
// import { SimpleViewer } from './components/PdfViewer/SimpleViewer';
import { SingleCanvasViewer } from "./components/PdfViewer/SingleCanvasViewer";

function App() {
  return (
    <div className="App">
      <SingleCanvasViewer />
    </div>
  );
}

export default App;
