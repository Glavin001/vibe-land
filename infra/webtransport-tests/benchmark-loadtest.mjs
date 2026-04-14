function parseArgs(argv) {
  const args = {
    url: null,
    scenario: null,
    headless: false,
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    switch (value) {
      case "--url":
        args.url = argv[i + 1] ?? null;
        i += 1;
        break;
      case "--scenario":
        args.scenario = argv[i + 1] ?? null;
        i += 1;
        break;
      case "--headless":
        args.headless = true;
        break;
      case "--check":
        args.check = true;
        break;
      default:
        break;
    }
  }
  if (!args.check && (!args.url || !args.scenario)) {
    throw new Error("Usage: benchmark-loadtest.mjs --url <client-url> --scenario <json> [--headless]");
  }
  return args;
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    try {
      ({ chromium } = await import(new URL("./node_modules/playwright/index.js", import.meta.url).href));
    } catch {
      throw new Error(
        "Playwright is not installed. Run `cd infra/webtransport-tests && npm install` before running benchmarks.",
      );
    }
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    return;
  }
  const scenario = JSON.parse(args.scenario);
  const pageUrl = new URL("/loadtest", args.url);
  pageUrl.searchParams.set("benchmark", "1");
  pageUrl.searchParams.set("autostart", "1");
  pageUrl.searchParams.set("scenario", JSON.stringify(scenario));

  const browser = await chromium.launch({
    headless: args.headless,
    args: ["--no-sandbox", "--enable-quic"],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  try {
    await page.goto(pageUrl.toString(), { waitUntil: "networkidle", timeout: 30_000 });
    const startupTimeoutMs = Math.max(60_000, (scenario.rampUpS ?? 0) * 1000 + 30_000);
    await page.waitForFunction(() => {
      return window.__VIBE_BENCHMARK_STATE__?.mode === "running"
        || window.__VIBE_BENCHMARK_STATE__?.mode === "completed"
        || window.__VIBE_BENCHMARK_STATE__?.mode === "failed";
    }, { timeout: startupTimeoutMs });
    const timeoutMs = (scenario.durationS ?? 30) * 1000 + 45_000;
    await page.waitForFunction(() => {
      const mode = window.__VIBE_BENCHMARK_STATE__?.mode;
      return mode === "completed" || mode === "failed";
    }, { timeout: timeoutMs });

    const payload = await page.evaluate(() => ({
      result: window.__VIBE_BENCHMARK_RESULT__ ?? window.__VIBE_GET_BENCHMARK_RESULT__?.() ?? null,
      state: window.__VIBE_BENCHMARK_STATE__ ?? null,
    }));
    process.stdout.write(`${JSON.stringify({
      result: payload.result,
      state: payload.state,
      consoleErrors,
      pageErrors,
    })}\n`);
  } catch (error) {
    let payload = { result: null, state: null };
    try {
      payload = await page.evaluate(() => ({
        result:
          window.__VIBE_BENCHMARK_RESULT__
          ?? window.__VIBE_GET_BENCHMARK_RESULT__?.()
          ?? window.__VIBE_BENCHMARK_STATE__?.result
          ?? null,
        state: window.__VIBE_BENCHMARK_STATE__ ?? null,
      }));
    } catch {
      payload = { result: null, state: null };
    }
    process.stdout.write(`${JSON.stringify({
      result: payload.result,
      state: payload.state,
      consoleErrors,
      pageErrors,
      error: error?.message ?? String(error),
    })}\n`);
    throw error;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
