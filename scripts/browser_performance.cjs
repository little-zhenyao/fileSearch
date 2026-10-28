// Browser P95 on the 100-file/3000-page synthetic benchmark library.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const base = process.env.FILESEARCH_TEST_URL || "http://127.0.0.1:8768";
const library = process.env.FILESEARCH_TEST_LIBRARY;
if (!library)
  throw new Error("An explicit isolated FILESEARCH_TEST_LIBRARY is required.");
const output = path.resolve(
  __dirname,
  "..",
  ".local",
  "v2-benchmark",
  "browser-performance.json",
);
const percentile = (values) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [],
    external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (
      !url.startsWith(base + "/") &&
      !url.startsWith("data:") &&
      !url.startsWith("blob:")
    ) {
      external.push(url);
      return route.abort();
    }
    return route.continue();
  });
  const settings = await (
    await page.request.get(base + "/api/settings")
  ).json();
  assert.equal(
    path.resolve(settings.library_path),
    path.resolve(library),
    "Refusing a different library.",
  );
  await page.request.put(base + "/api/workspace", {
    headers: { "X-Local-Request": "1" },
    data: {},
  });
  await page.goto(base);
  const input = page.getByLabel("搜索课程资料");
  await input.waitFor();
  await page.getByRole("button", { name: "搜索", exact: true }).waitFor();
  const searchMs = [],
    singleMs = [],
    dualMs = [];
  for (let index = 0; index < 20; index++) {
    await input.fill("deadlock");
    const start = performance.now();
    const pending = page.waitForResponse((response) =>
      response.url().includes("/api/search?"),
    );
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await pending;
    await page.locator(".result-group").first().waitFor();
    searchMs.push(performance.now() - start);
  }
  const pane0 = page.locator('[data-reader-pane="0"]'),
    pane1 = page.locator('[data-reader-pane="1"]');
  for (let index = 0; index < 20; index++) {
    const group = page.locator(".result-group").nth(index % 20);
    const expected = await group.locator(".result-file strong").textContent();
    const start = performance.now();
    await group.locator(".hit-card").first().click();
    await page.waitForFunction(
      (name) =>
        document.querySelector('[data-reader-pane="0"] .reader-title strong')
          ?.textContent === name,
      expected,
    );
    await pane0.locator(".pdf-highlight.active").first().waitFor();
    await pane0.locator(".textLayer span").first().waitFor();
    singleMs.push(performance.now() - start);
  }
  await page.getByRole("button", { name: "双文档对照", exact: true }).click();
  await pane0.focus();
  for (let index = 0; index < 20; index++) {
    const group = page.locator(".result-group").nth(index % 20);
    const expected = await group.locator(".result-file strong").textContent();
    const start = performance.now();
    await group.locator(".other-open").first().click();
    await page.waitForFunction(
      (name) =>
        document.querySelector('[data-reader-pane="1"] .reader-title strong')
          ?.textContent === name,
      expected,
    );
    await pane1.locator(".pdf-highlight.active").first().waitFor();
    await pane1.locator(".textLayer span").first().waitFor();
    dualMs.push(performance.now() - start);
    await pane0.focus();
  }
  const report = {
    kind: "Synthetic 100-file/3000-page browser benchmark, local warm cache, 20 samples each",
    search: { p95_ms: Math.round(percentile(searchMs)), samples_ms: searchMs },
    single_reader: {
      p95_ms: Math.round(percentile(singleMs)),
      samples_ms: singleMs,
    },
    dual_reader: { p95_ms: Math.round(percentile(dualMs)), samples_ms: dualMs },
    errors,
    external,
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        search_p95_ms: report.search.p95_ms,
        single_p95_ms: report.single_reader.p95_ms,
        dual_p95_ms: report.dual_reader.p95_ms,
        errors,
        external,
        output,
      },
      null,
      2,
    ),
  );
  assert(report.search.p95_ms <= 1000);
  assert(report.single_reader.p95_ms <= 2000);
  assert(report.dual_reader.p95_ms <= 2000);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
