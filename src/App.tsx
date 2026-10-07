import { lazy, Suspense, useEffect, useRef } from 'react';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import { TabBar } from './components/TabBar';
import { Toaster } from './components/Toaster';
import { useSpot } from './hooks/useSpot';
import { CarPage } from './pages/CarPage';
import { HomePage } from './pages/HomePage';

// Calibration (fixing a camera's curb outline) is a rarely used desktop tool; keep it out of the main bundle.
const CalibratePage = lazy(() => import('./pages/CalibratePage'));

export function App() {
  const spotState = useSpot();
  const [location, navigate] = useLocation();

  // Opening the app with the car parked lands on "My car"; otherwise on "Find parking".
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current || spotState.spot === undefined) return;
    decided.current = true;
    if (spotState.spot && location === '/') navigate('/car', { replace: true });
  }, [spotState.spot, location, navigate]);

  const tabbed = location === '/' || location === '/car';
  // Don't start camera checks on "/" before we know whether to show "My car" instead.
  const waiting = location === '/' && spotState.spot === undefined;

  return (
    <>
      <div className={tabbed ? 'tabbed' : undefined}>
        <Switch>
          <Route path="/">{waiting ? <div className="page" aria-busy="true" /> : <HomePage />}</Route>
          <Route path="/car">
            <CarPage spotState={spotState} />
          </Route>
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
      </div>
      {tabbed && <TabBar />}
      <Toaster />
    </>
  );
}
