#!/usr/bin/env node
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = join(ROOT, 'client', 'test-results', 'practice-proof');
const APP_URL = process.env.VIBE_PRACTICE_URL ?? 'http://localhost:3003/practice';
const VIEWPORT = { width: 1280, height: 720 };
const CHROME_EXECUTABLE =
  process.env.PLAYWRIGHT_CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return import(new URL('../infra/webtransport-tests/node_modules/playwright/index.mjs', import.meta.url).href);
  }
}

async function isVisible(locator, timeout = 1500) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function bootPractice(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1000);

  const launchPrompt = page.getByText(/Click anywhere to launch the firing range/i);
  if (await isVisible(launchPrompt, 3_000)) {
    await launchPrompt.click();
  } else {
    await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
  }

  const maybeLater = page.getByRole('button', { name: /Maybe later/i });
  if (await isVisible(maybeLater, 2_000)) {
    await maybeLater.click();
  }

  await page.waitForTimeout(1500);
  await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await page.waitForTimeout(250);
  await page.keyboard.press('F3').catch(() => {});
  await page.waitForTimeout(250);
}

async function runScenario(browser, { name, driveMs }) {
  const scenarioDir = join(OUTPUT_DIR, name);
  const videoDir = join(scenarioDir, 'video-temp');
  await mkdir(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    ignoreHTTPSErrors: true,
    recordVideo: {
      dir: videoDir,
      size: VIEWPORT,
    },
  });
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[destructibles]') || text.includes('Pointer lock')) {
      consoleLines.push(`[${msg.type()}] ${text}`);
    }
  });

  await bootPractice(page);
  await page.screenshot({ path: join(scenarioDir, '00-ready.png') });

  await page.keyboard.press('e');
  await page.waitForTimeout(700);
  await page.keyboard.down('w');
  await page.waitForTimeout(driveMs);
  await page.keyboard.up('w');
  await page.waitForTimeout(1500);

  await page.screenshot({ path: join(scenarioDir, '01-end.png') });

  const fractureLines = consoleLines.filter((line) => line.includes('FRACTURE'));
  const describeLines = consoleLines.filter((line) => line.includes('describe'));
  await writeFile(
    join(scenarioDir, 'console.log'),
    `${consoleLines.join('\n')}\n`,
    'utf8',
  );
  await writeFile(
    join(scenarioDir, 'summary.json'),
    JSON.stringify(
      {
        url: APP_URL,
        driveMs,
        fractureCount: fractureLines.length,
        describeLines,
      },
      null,
      2,
    ),
    'utf8',
  );

  const video = page.video();
  await page.close();
  const originalVideoPath = await video.path();
  await context.close();

  const finalVideoPath = join(OUTPUT_DIR, `${name}.webm`);
  await rename(originalVideoPath, finalVideoPath);
  return { finalVideoPath, fractureCount: fractureLines.length };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    headless: false,
    executablePath: CHROME_EXECUTABLE,
    args: ['--no-sandbox', '--enable-quic'],
  });

  try {
    const collision = await runScenario(browser, { name: 'collision-block', driveMs: 2200 });
    const fracture = await runScenario(browser, { name: 'fracture-drive', driveMs: 6000 });
    process.stdout.write(
      `${JSON.stringify(
        {
          outputDir: OUTPUT_DIR,
          collision,
          fracture,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
