import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LandingPage } from './pages/LandingPage';
import { JoinPage } from './pages/JoinPage';
import { UmpirePage } from './pages/UmpirePage';
import { StationPage } from './pages/StationPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/g/:gameId/umpire" element={<UmpirePage />} />
        <Route path="/g/:gameId/v/:accessToken/s/:stationId" element={<StationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
