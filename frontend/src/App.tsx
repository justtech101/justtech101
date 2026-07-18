import { NavLink, Route, Routes } from "react-router-dom";
import { HashRouter } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Profiles from "./pages/Profiles";

export default function App() {
  return (
    <HashRouter>
      <div className="app-shell">
        <header className="app-header">
          <strong>JUSTTECH Application Manager</strong>
          <nav>
            <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
              Dashboard
            </NavLink>
            <NavLink to="/profiles" className={({ isActive }) => (isActive ? "active" : "")}>
              Profiles
            </NavLink>
          </nav>
        </header>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/profiles" element={<Profiles />} />
        </Routes>
      </div>
    </HashRouter>
  );
}
