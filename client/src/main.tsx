import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ServerStats } from './pages/ServerStats';

const root = createRoot(document.getElementById('root')!);

if (window.location.pathname === '/stats') {
  root.render(<ServerStats />);
} else {
  root.render(<App />);
}
