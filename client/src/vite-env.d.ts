/// <reference types="vite/client" />

/** Build stamp, injected by vite.config.ts. */
declare const __CLIENT_BUILD__: string;

/** Absolute path to destruction/assets/scenes, injected by vite.config.ts. */
declare const __SCENES_DIR__: string;

/** True in the three/webgpu build (`vite --mode webgpu`, the native app), false in the WebGL client. */
declare const __WEBGPU__: boolean;

/** True in the native macOS app's bundle (`vite build --mode native`). */
declare const __NATIVE__: boolean;
