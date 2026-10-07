import { lazy, Suspense } from 'react';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import { Toaster } from './components/Toaster';
import { useSpot } from './hooks/useSpot';
import { MapScreen } from './pages/MapScreen';

// Calibration (fixing a camera's curb outline) is a rarely used desktop tool; keep it out of the main bundle.
const CalibratePage = lazy(() => import('./pages/CalibratePage'));

export function App() {
  const spotState = useSpot();
  const [location] = useLocation();
  // The map is the app; /find opens the Find parking sheet over it (same map, not a new one).
  const onMap = location === '/' || location === '/find';
  return (
    <>
      {onMap ? (
        <MapScreen spotState={spotState} />
      ) : (
        <Switch>
          <Route path="/calibrate/:cameraId">
            {(params) => (
              <Suspense fallback={<div className="page" aria-busy="true" />}>
                <CalibratePage cameraId={params.cameraId} />
              </Suspense>
            )}
          </Route>
          <Route>
            <Redirect to="/" replace />
          </Route>
        </Switch>
      )}
      <Toaster />
    </>
  );
}
