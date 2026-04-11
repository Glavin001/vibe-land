import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LoadTestPage } from './pages/LoadTest';
import { ServerStats } from './pages/ServerStats';

const root = createRoot(document.getElementById('root')!);

if (window.location.pathname === '/stats') {
  root.render(<ServerStats />);
} else if (window.location.pathname === '/loadtest') {
  root.render(<LoadTestPage />);
} else {
  root.render(<App />);
}
