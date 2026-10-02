import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { installUiButtonClickSfx } from './audio/uiButtonClick';
import { LandingPage } from './pages/LandingPage';
import { JoinPage } from './pages/JoinPage';
import { UmpirePage } from './pages/UmpirePage';
import { StationPage } from './pages/StationPage';

/** Remount when game/vessel/station identity changes so auth + drafts reset. */
function StationRoute() {
  const { gameId = '', accessToken = '', stationId = '' } = useParams();
  return (
    <StationPage key={`${gameId}:${accessToken}:${stationId}`} />
  );
}

function UmpireRoute() {
  const { gameId = '' } = useParams();
  return <UmpirePage key={gameId} />;
}

export function App() {
  useEffect(() => installUiButtonClickSfx(), []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/g/:gameId/umpire" element={<UmpireRoute />} />
        <Route
          path="/g/:gameId/v/:accessToken/s/:stationId"
          element={<StationRoute />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
