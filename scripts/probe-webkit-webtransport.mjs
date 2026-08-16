#!/usr/bin/env node
/**
 * What does WebKit actually support?
 *
 * iOS runs WebKit in every browser, including Chrome, so the iOS failure is
 * most likely an engine capability gap rather than anything about the phone.
 * Playwright ships a WebKit build we can drive here.
 *
 * Caveat worth keeping in mind when reading the output: this is WebKit on
 * Linux, not Safari on iOS. They share the engine but not the networking
 * stack, so a positive result here would NOT prove iOS works. A negative
 * result is the informative one -- if the API is missing from the engine
 * entirely, no amount of iOS-side configuration brings it back.
 *
 *   node scripts/probe-webkit-webtransport.mjs [pageUrl] [wtUrl] [certHashHex]
 */

import { createRequire } from 'node:module';

const require = createRequire(new URL('../client/package.json', import.meta.url));
const { webkit, chromium } = require('@playwright/test');

const PAGE_URL = process.argv[2] ?? 'http://127.0.0.1:5556/';
const WT_URL = process.argv[3] ?? 'https://127.0.0.1:4433/game';
const CERT_HASH = process.argv[4] ?? '';

const probe = async (browserType, name) => {
  const browser = await browserType.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const result = await page.evaluate(
    async ([wtUrl, certHash]) => {
      const out = {
        userAgent: navigator.userAgent,
        isSecureContext: window.isSecureContext,
        hasWebTransport: typeof window.WebTransport !== 'undefined',
        withHashes: null,
        withoutHashes: null,
      };
      if (!out.hasWebTransport) return out;

      const hexToBytes = (hex) =>
        Uint8Array.from(hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []);

      const attempt = async (options) => {
        try {
          const transport = new window.WebTransport(wtUrl, options);
          const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout after 8s')), 8000),
          );
          await Promise.race([transport.ready, timeout]);
          transport.close();
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            name: error?.name ?? 'unknown',
            message: String(error?.message ?? error).slice(0, 300),
          };
        }
      };

      out.withHashes = certHash
        ? await attempt({
            serverCertificateHashes: [{ algorithm: 'sha-256', value: hexToBytes(certHash) }],
            requireUnreliable: true,
          })
        : { skipped: 'no cert hash supplied' };
      out.withoutHashes = await attempt({ requireUnreliable: true });
      return out;
    },
    [WT_URL, CERT_HASH],
  );

  await browser.close();
  return { engine: name, ...result };
};

for (const [type, name] of [
  [chromium, 'Chromium (baseline: known good)'],
  [webkit, 'WebKit (engine iOS Safari uses)'],
]) {
  try {
    const result = await probe(type, name);
    console.log(`\n=== ${result.engine} ===`);
    console.log(`  secure context : ${result.isSecureContext}`);
    console.log(`  WebTransport   : ${result.hasWebTransport ? 'present' : 'MISSING'}`);
    if (result.hasWebTransport) {
      console.log(`  with hashes    : ${JSON.stringify(result.withHashes)}`);
      console.log(`  without hashes : ${JSON.stringify(result.withoutHashes)}`);
    }
    console.log(`  ua             : ${result.userAgent.slice(0, 110)}`);
  } catch (error) {
    console.log(`\n=== ${name} ===\n  probe failed: ${error.message.slice(0, 200)}`);
  }
}
