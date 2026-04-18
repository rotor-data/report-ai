import { Link, Outlet } from "react-router-dom";

export default function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>Report AI</h1>
        <nav>
          <Link to="/">Dashboard</Link>
          <Link to="/documents/new">Nytt dokument</Link>
          <Link to="/v2">V2 Reports</Link>
          <Link to="/v2/components">Komponenter</Link>
          <Link to="/v2/assets">Tillgångar</Link>
          <Link to="/fonts">Typsnitt</Link>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
