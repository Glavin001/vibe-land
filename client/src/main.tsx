import './index.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveAppRoute } from './app/routes';
import { LoadTestPage } from './pages/LoadTest';
import { HomePage } from './pages/Home';
import { ServerStats } from './pages/ServerStats';
import { GodModePage } from './pages/GodMode';
import { GalleryPage } from './pages/Gallery';
import { SharedPracticePage } from './pages/SharedPractice';

// E2E bridge: always-on read-only introspection for Playwright tests.
// Importing the module installs window.__VIBE_E2E__ immediately.
import './e2eBridge';

const root = createRoot(document.getElementById('root')!);

// Backwards-compat: silently rewrite /godmode to /builder/world so the URL
// matches the new canonical path. Do this before resolving the route so the
// builder sees the updated URL if it reads it later.
if (window.location.pathname === '/godmode' || window.location.pathname === '/godmode/') {
  window.history.replaceState(null, '', '/builder/world' + window.location.search + window.location.hash);
}

// Vibe Jam portal landing: `/` is the URL we publish to the webring, so any
// portal-arrival hits there. Forward to `/play` (auto-connect happens once the
// game route loads) while preserving the full query string + hash.
if (
  (window.location.pathname === '/' || window.location.pathname === '/index.html')
  && new URLSearchParams(window.location.search).get('portal') === 'true'
) {
  window.history.replaceState(
    null,
    '',
    '/play' + window.location.search + window.location.hash,
  );
}

const route = resolveAppRoute(window.location.pathname, window.location.search);

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
  case 'sharedPractice':
    root.render(<SharedPracticePage id={route.id} />);
    break;
  case 'builder':
    root.render(<GodModePage publishedId={route.publishedId} />);
    break;
  case 'gallery':
    root.render(<GalleryPage />);
    break;
  case 'launcher':
  default:
    root.render(<HomePage />);
}
