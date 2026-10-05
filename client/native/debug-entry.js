// mystralnative reports nothing when a module throws while it evaluates, and
// its V8 has no dynamic import(). For debugging, scripts/native-mac.sh debug
// converts the bundle to an IIFE and this entry evaluates it, so the error
// (with its stack) is printed.
console.log('[debug] evaluating game-iife.js');
fetch('file://./game-iife.js')
  .then((response) => response.text())
  .then((source) => {
    try {
      (0, eval)(source);
      console.log('[debug] evaluated');
    } catch (error) {
      console.error('[debug] evaluation threw:', error && (error.stack || error.message || String(error)));
    }
  })
  .catch((error) => console.error('[debug] could not read game-iife.js:', String(error)));
