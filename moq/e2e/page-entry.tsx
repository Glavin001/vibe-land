/**
 * Mounts the real demo page for the second phase of `verify-local.mjs`.
 *
 * The route in `client/src/main.tsx` pulls in the whole game bundle, WASM and
 * all, which is far more than this check needs. Rendering the page component
 * directly keeps the test to the thing under test.
 */

import { createRoot } from 'react-dom/client';

import { MoqDemoPage } from '../../client/src/pages/MoqDemo';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(<MoqDemoPage />);
