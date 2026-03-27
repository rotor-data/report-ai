import { createBrowserRouter } from "react-router-dom";
import App from "./App";
import Dashboard from "./pages/Dashboard";
import DocumentNew from "./pages/DocumentNew";
import DocumentEdit from "./pages/DocumentEdit";
import FontManager from "./pages/FontManager";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "documents/new", element: <DocumentNew /> },
      { path: "documents/:id", element: <DocumentEdit /> },
      { path: "fonts", element: <FontManager /> },
    ],
  },
]);
