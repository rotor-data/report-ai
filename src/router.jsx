import { createBrowserRouter } from "react-router-dom";
import App from "./App";
import Dashboard from "./pages/Dashboard";
import DocumentNew from "./pages/DocumentNew";
import DocumentEdit from "./pages/DocumentEdit";
import FontManager from "./pages/FontManager";
import V2Dashboard from "./pages/V2Dashboard";
import V2ReportEditor from "./pages/V2ReportEditor";
import V2AssetLibrary from "./pages/V2AssetLibrary";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "documents/new", element: <DocumentNew /> },
      { path: "documents/:id", element: <DocumentEdit /> },
      { path: "fonts", element: <FontManager /> },
      { path: "v2", element: <V2Dashboard /> },
      { path: "v2/reports/:id", element: <V2ReportEditor /> },
      { path: "v2/assets", element: <V2AssetLibrary /> },
    ],
  },
]);
