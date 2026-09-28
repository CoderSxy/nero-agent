import { Navigate, Route, Routes } from 'react-router-dom';
import { ChatPage } from './pages/ChatPage';
import { StudioPage } from './pages/StudioPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/chat/new" replace />} />
      <Route path="/chat/new" element={<ChatPage />} />
      <Route path="/chat/:threadId" element={<ChatPage />} />
      <Route path="/studio" element={<StudioPage />} />
    </Routes>
  );
}
