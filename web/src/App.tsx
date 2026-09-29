import { Navigate, Route, Routes } from 'react-router-dom';
import { AgentPage } from './agent/AgentPage';

export function App() {
  return <Routes>
    <Route path="/agent/new" element={<AgentPage />} />
    <Route path="/agent/:threadId" element={<AgentPage />} />
    <Route path="*" element={<Navigate to="/agent/new" replace />} />
  </Routes>;
}
