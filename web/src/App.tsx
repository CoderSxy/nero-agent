import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { MastraReactProvider } from '@mastra/react';
import { AgentPage } from './agent/AgentPage';
import { setAgentClientToken } from './agent/client';

export type CurrentUser = { id: string; email: string; displayName: string; roles: ('admin' | 'user')[] };
const TOKEN_KEY = 'nero-agent-session';

function LoginPage({ onLogin }: { onLogin: (token: string, user: CurrentUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/auth/login', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '登录失败');
      onLogin(result.token, result.user);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败'); }
    finally { setBusy(false); }
  }
  return <main className="login-page"><form className="login-card" onSubmit={event => void submit(event)}>
    <div className="login-brand">NERO <span>AGENT</span></div>
    <h1>登录 NERO AGENT</h1>
    <label htmlFor="login-email">邮箱</label>
    <input id="login-email" type="email" autoComplete="username" required value={email}
      onChange={event => setEmail(event.target.value)} />
    <label htmlFor="login-password">密码</label>
    <input id="login-password" type="password" autoComplete="current-password" required value={password}
      onChange={event => setPassword(event.target.value)} />
    {error && <p role="alert" className="error">{error}</p>}
    <button type="submit" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
  </form></main>;
}

export function App() {
  const routeLocation = useLocation();
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [checking, setChecking] = useState(Boolean(token));
  useEffect(() => {
    setAgentClientToken(token);
    if (!token) { setChecking(false); return; }
    let active = true;
    fetch('/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(async response => { if (!response.ok) throw new Error('会话已过期');
        return response.json() as Promise<{ user: CurrentUser }>; })
      .then(result => { if (active) setUser(result.user); })
      .catch(() => { if (active) { sessionStorage.removeItem(TOKEN_KEY); setToken(null); setUser(null); } })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [token]);
  function onLogin(nextToken: string, nextUser: CurrentUser) {
    sessionStorage.setItem(TOKEN_KEY, nextToken);
    setAgentClientToken(nextToken);
    setToken(nextToken); setUser(nextUser); setChecking(false);
  }
  function onLogout() {
    if (token) void fetch('/auth/logout', { method: 'POST',
      headers: { Authorization: `Bearer ${token}` } });
    sessionStorage.removeItem(TOKEN_KEY); setAgentClientToken(null); setToken(null); setUser(null);
  }
  if (checking) return <main className="login-page">正在验证登录…</main>;
  if (!token || !user) return <LoginPage onLogin={onLogin} />;
  if (new URLSearchParams(routeLocation.search).get('next') === 'studio') {
    return <main className="login-page"><div className="login-card">
      <div className="login-brand">NERO <span>AGENT</span></div>
      {user.roles.includes('admin') ? <>
        <h1>进入 Mastra Studio</h1>
        <p>使用当前管理员账号进入。</p>
        <a href="/studio/">进入 Studio</a>
      </> : <>
        <h1>仅管理员可以进入 Studio</h1>
        <a href="/agent/new">返回智能体</a>
      </>}
    </div></main>;
  }
  return <MastraReactProvider baseUrl="" apiPrefix="/api"
    headers={{ Authorization: `Bearer ${token}` }}>
    <Routes>
      <Route path="/agent/:threadId" element={<AgentPage user={user} onLogout={onLogout} />} />
      <Route path="*" element={<Navigate to="/agent/new" replace />} />
    </Routes>
  </MastraReactProvider>;
}
