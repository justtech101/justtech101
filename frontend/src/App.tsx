import { HashRouter, NavLink, Route, Routes } from "react-router-dom";
import ApplicationDetail from "./pages/ApplicationDetail";
import Applications from "./pages/Applications";
import AuditLog from "./pages/AuditLog";
import Credentials from "./pages/Credentials";
import Dashboard from "./pages/Dashboard";
import IngestionSources from "./pages/IngestionSources";
import OpportunityDetail from "./pages/OpportunityDetail";
import Opportunities from "./pages/Opportunities";
import ProfileDetail from "./pages/ProfileDetail";
import Profiles from "./pages/Profiles";

const NAV_LINKS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/opportunities", label: "Opportunities" },
  { to: "/applications", label: "Applications" },
  { to: "/profiles", label: "Profiles" },
  { to: "/sources", label: "Sources" },
  { to: "/credentials", label: "Credentials" },
  { to: "/audit", label: "Audit Log" },
];

export default function App() {
  return (
    <HashRouter>
      <div className="app-shell">
        <header className="app-header">
          <strong>JUSTTECH Application Manager</strong>
          <nav>
            {NAV_LINKS.map((link) => (
              <NavLink key={link.to} to={link.to} end={link.end} className={({ isActive }) => (isActive ? "active" : "")}>
                {link.label}
              </NavLink>
            ))}
          </nav>
        </header>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/opportunities" element={<Opportunities />} />
          <Route path="/opportunities/:id" element={<OpportunityDetail />} />
          <Route path="/applications" element={<Applications />} />
          <Route path="/applications/:id" element={<ApplicationDetail />} />
          <Route path="/profiles" element={<Profiles />} />
          <Route path="/profiles/:id" element={<ProfileDetail />} />
          <Route path="/sources" element={<IngestionSources />} />
          <Route path="/credentials" element={<Credentials />} />
          <Route path="/audit" element={<AuditLog />} />
        </Routes>
      </div>
    </HashRouter>
  );
}
