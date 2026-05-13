import { createBrowserRouter } from "react-router-dom";
import App from "./App";
import Dashboard from "./pages/Dashboard";
import DocumentNew from "./pages/DocumentNew";
import DocumentEdit from "./pages/DocumentEdit";
import FontManager from "./pages/FontManager";
import V2Dashboard from "./pages/V2Dashboard";
import V2AssetLibrary from "./pages/V2AssetLibrary";
import V2ComponentLibrary from "./pages/V2ComponentLibrary";
import EditorV2 from "./pages/EditorV2";
import V2ReportEditorRedirect from "./pages/V2ReportEditorRedirect";

export const router = createBrowserRouter([
  // Scoped token-authenticated editor — rendered OUTSIDE the App layout
  // so no SPA chrome leaks into the standalone editor surface.
  { path: "/editor/v2", element: <EditorV2 /> },
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "documents/new", element: <DocumentNew /> },
      { path: "documents/:id", element: <DocumentEdit /> },
      { path: "fonts", element: <FontManager /> },
      { path: "v2", element: <V2Dashboard /> },
      // Legacy V2ReportEditor route — kept as a transparent redirect so
      // existing bookmarks land in the modern token-authed editor.
      // Mints a fresh editor token via /api/v2-editor-url and replaces
      // the URL. See V2ReportEditorRedirect.jsx.
      { path: "v2/reports/:id", element: <V2ReportEditorRedirect /> },
      { path: "v2/assets", element: <V2AssetLibrary /> },
      { path: "v2/components", element: <V2ComponentLibrary /> },
    ],
  },
]);
