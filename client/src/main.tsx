import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveAppRoute } from './app/routes';
import { LoadTestPage } from './pages/LoadTest';
import { HomePage } from './pages/Home';
import { ServerStats } from './pages/ServerStats';
import { GodModePage } from './pages/GodMode';

// E2E bridge: always-on read-only introspection for Playwright tests.
// Importing the module installs window.__VIBE_E2E__ immediately.
import './e2eBridge';

const root = createRoot(document.getElementById('root')!);
const route = resolveAppRoute(window.location.pathname);

switch (route.kind) {
  case 'stats':
    root.render(<ServerStats />);
    break;
  case 'loadtest':
    root.render(<LoadTestPage />);
    break;
  case 'game':
    root.render(<App mode={route.mode} />);
    break;
  case 'godmode':
    root.render(<GodModePage />);
    break;
  case 'launcher':
  default:
    root.render(<HomePage />);
}
