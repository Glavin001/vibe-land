function parseArgs(argv) {
  const args = {
    url: null,
    scenario: null,
    clients: 1,
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
      case "--clients":
        args.clients = Number.parseInt(argv[i + 1] ?? "1", 10) || 1;
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
    throw new Error("Usage: benchmark-play.mjs --url <client-url> --scenario <json> [--clients <n>] [--headless]");
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
  const browser = await chromium.launch({
    headless: args.headless,
    args: ["--no-sandbox", "--enable-quic"],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  });

  const pages = [];
  const consoleErrors = [];
  const pageErrors = [];

  try {
    for (let index = 0; index < Math.max(1, args.clients); index += 1) {
      const page = await context.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          consoleErrors.push(`[play-${index + 1}] ${msg.text()}`);
        }
      });
      page.on("pageerror", (error) => {
        pageErrors.push(`[play-${index + 1}] ${error.message}`);
      });

      const pageUrl = new URL("/play", args.url);
      pageUrl.searchParams.set("match", scenario.matchId ?? "arena");
      pageUrl.searchParams.set("benchmark", "1");
      pageUrl.searchParams.set("autostart", "1");
      pageUrl.searchParams.set("autopilot", "1");
      pageUrl.searchParams.set("clientIndex", String(index));
      pageUrl.searchParams.set("clientLabel", `play-${index + 1}`);
      pageUrl.searchParams.set("scenario", JSON.stringify(scenario));

      await page.goto(pageUrl.toString(), { waitUntil: "networkidle", timeout: 30_000 });
      pages.push(page);
    }

    await Promise.all(pages.map((page) => page.waitForFunction(() => {
      const mode = window.__VIBE_PLAY_BENCHMARK_STATE__?.mode;
      return mode === "running" || mode === "completed" || mode === "failed";
    }, { timeout: 30_000 })));

    const timeoutMs = (scenario.durationS ?? 30) * 1000 + 45_000;
    await Promise.all(pages.map((page) => page.waitForFunction(() => {
      const mode = window.__VIBE_PLAY_BENCHMARK_STATE__?.mode;
      return mode === "completed" || mode === "failed";
    }, { timeout: timeoutMs })));

    const payload = await Promise.all(pages.map((page) => page.evaluate(() => ({
      result:
        window.__VIBE_PLAY_BENCHMARK_RESULT__
        ?? window.__VIBE_GET_PLAY_BENCHMARK_RESULT__?.()
        ?? null,
      state: window.__VIBE_PLAY_BENCHMARK_STATE__ ?? null,
    }))));
    process.stdout.write(`${JSON.stringify({
      results: payload.map((entry) => entry.result),
      states: payload.map((entry) => entry.state),
      consoleErrors,
      pageErrors,
    })}\n`);
  } catch (error) {
    const states = await Promise.all(pages.map(async (page) => {
      try {
        return await page.evaluate(() => window.__VIBE_PLAY_BENCHMARK_STATE__ ?? null);
      } catch {
        return null;
      }
    }));
    process.stdout.write(`${JSON.stringify({
      results: [],
      states,
      consoleErrors,
      pageErrors,
      error: error?.message ?? String(error),
    })}\n`);
    throw error;
  } finally {
    await Promise.all(pages.map((page) => page.close().catch(() => {})));
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
