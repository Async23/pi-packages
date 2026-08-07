import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Sessions from './pages/Sessions';
import SessionDetail from './pages/SessionDetail';
import Search from './pages/Search';
import Insights from './pages/Insights';
import Schema from './pages/Schema';

const NAV = [
  { to: '/', label: '总览', end: true },
  { to: '/sessions', label: '会话' },
  { to: '/search', label: '全局搜索' },
  { to: '/insights', label: '统计洞察' },
  { to: '/schema', label: '数据格式' },
];

const THEMES = {
  light: { icon: '✹', label: '明亮', next: 'dark' },
  dark: { icon: '☾', label: '暗色', next: 'auto' },
  auto: { icon: '◑', label: '跟随系统', next: 'light' },
};

function PiMark() {
  return (
    <svg viewBox="0 0 800 800" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    const initial = document.documentElement.dataset.theme;
    return THEMES[initial] ? initial : 'auto';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('pi-sessions-theme', theme);
    } catch {
      // localStorage 不可用不影响主题切换
    }
  }, [theme]);

  const currentTheme = THEMES[theme];
  const nextTheme = THEMES[currentTheme.next];

  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="Pi Sessions Studio 总览">
          <span className="logo-mark"><PiMark /></span>
          <span className="brand-copy">
            <div className="logo-title">Pi Sessions Studio</div>
            <div className="logo-sub">Local session intelligence</div>
          </span>
        </NavLink>
        <nav className="topnav" aria-label="主导航">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-meta">
          <div className="topbar-source" title="数据源：~/.pi/agent/sessions">
            <span>数据源</span>
            <strong>~/.pi/agent/sessions</strong>
          </div>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme(currentTheme.next)}
            title={`当前模式：${currentTheme.label}；点击切换为${nextTheme.label}`}
            aria-label={`当前主题为${currentTheme.label}，切换为${nextTheme.label}`}
          >
            {currentTheme.icon}
          </button>
        </div>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/search" element={<Search />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/schema" element={<Schema />} />
        </Routes>
      </main>
    </div>
  );
}
