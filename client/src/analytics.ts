import posthog from 'posthog-js';

const apiKey = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const apiHost = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';

export function initAnalytics(): void {
  if (!apiKey) return;
  posthog.init(apiKey, {
    api_host: apiHost,
    capture_pageview: false,
    capture_pageleave: true,
    persistence: 'localStorage+cookie',
    session_recording: {
      maskAllInputs: true,
    },
  });
}

export function trackPageView(route: string, properties?: Record<string, unknown>): void {
  if (!apiKey) return;
  posthog.capture('$pageview', { route, ...properties });
}

export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  if (!apiKey) return;
  posthog.capture(event, properties);
}
