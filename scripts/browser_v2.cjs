// Run only against a dedicated test server and the explicitly named test library.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const base = process.env.FILESEARCH_TEST_URL || "http://127.0.0.1:8767";
const library = process.env.FILESEARCH_TEST_LIBRARY;
if (!library)
  throw new Error("Set FILESEARCH_TEST_LIBRARY to the isolated test library.");
const output = path.join(root, ".local", "v2-qa", "browser");
fs.mkdirSync(output, { recursive: true });
const sleepPaint = async (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

let debugPage, debugBrowser, debugExpected;
(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  debugPage = page;
  debugBrowser = browser;
  const errors = [],
    external = [],
    steps = [];
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
  const request = async (route, body, method = "POST") => {
    const response = await page.request.fetch(base + "/api" + route, {
      method,
      headers: { "X-Local-Request": "1" },
      data: body,
    });
    assert(
      response.ok(),
      `${route}: ${response.status()} ${await response.text()}`,
    );
    return response.json();
  };
  const get = async (route) =>
    (await page.request.get(base + "/api" + route)).json();
  const poll = async (condition, label) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out: " + label);
  };
  const settings = await get("/settings");
  if (!settings.configured)
    await request("/settings", { library_path: library });
  else
    assert.equal(
      path.resolve(settings.library_path),
      path.resolve(library),
      "Refusing to mutate a different library.",
    );
  await request("/exam/exit");
  await request("/workspace", {}, "PUT");
  const courseName = "V2 validation " + Date.now();
  const course = await request("/courses", { name: courseName });
  const fixtures = path.join(root, ".local", "v2-qa", "fixtures");
  const names = [
    "V2_Lecture.pdf",
    "V2_Tutorial.pdf",
    "V2_Notes.docx",
    "V2_Exercises.docx",
  ];
  const payloads = names.map((name) => ({
    name,
    bytes: Array.from(fs.readFileSync(path.join(fixtures, name))),
  }));
  await page.goto(base);
  await page.evaluate(
    async ({ courseId, payloads }) => {
      const form = new FormData();
      form.set("course_id", courseId);
      form.set("paths", JSON.stringify(payloads.map((p) => p.name)));
      for (const file of payloads)
        form.append("files", new Blob([new Uint8Array(file.bytes)]), file.name);
      const result = await fetch("/api/import-jobs", {
        method: "POST",
        headers: { "X-Local-Request": "1" },
        body: form,
      });
      if (!result.ok) throw new Error(await result.text());
    },
    { courseId: course.id, payloads },
  );
  await page.goto(base);
  await poll(
    async () => (await get("/documents?course_id=" + course.id)).length === 4,
    "four imported fixtures",
  );
  await page
    .getByRole("button", { name: courseName, exact: false })
    .first()
    .click();
  // An informational endpoint must not prevent the actual library from loading.
  let failedStats = 0;
  const failStats = (route) => {
    failedStats++;
    return route.fulfill({
      status: 500,
      json: { detail: "Simulated statistics race" },
    });
  };
  await context.route("**/api/stats", failStats);
  await page.reload();
  await page
    .getByRole("button", { name: courseName, exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: /^课程资料/ }).click();
  await poll(
    async () => (await page.locator(".document-card").count()) === 4,
    "documents despite stats failure",
  );
  await poll(async () => failedStats >= 3, "repeated failed statistics polls");
  assert.equal(
    await page.locator(".toast").count(),
    0,
    "Optional statistics failures must not spam notifications",
  );
  await page.locator(".storage").click();
  assert.equal(
    await page.locator(".library-metrics strong").first().textContent(),
    String((await get("/documents")).length),
    "Unavailable statistics must not show zero documents",
  );
  await page.getByText("暂不可用", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "关闭本地资料库", exact: true })
    .click();
  const summaryCategory = page
    .locator(".category-nav")
    .getByRole("button", { name: /^Summary 总结/ });
  await summaryCategory.click();
  await page.getByText("当前分类下没有资料", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("这里还没有资料", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "显示所有资料", exact: true }).click();
  assert.equal(await page.locator(".document-card").count(), 4);
  await page.screenshot({ path: path.join(output, "00-library-filter.png") });
  await context.unroute("**/api/stats", failStats);
  steps.push(
    "statistics failure leaves documents available across polls; empty category can clear its filter",
  );

  const failDocuments = (route) =>
    route.fulfill({
      status: 503,
      json: { detail: "Simulated document list outage" },
    });
  await context.route("**/api/documents", failDocuments);
  await page.reload();
  await page
    .getByRole("button", { name: courseName, exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: /^课程资料/ }).click();
  await page.getByText("资料列表暂时无法刷新", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("这里还没有资料", { exact: true }).count(),
    0,
  );
  await context.unroute("**/api/documents", failDocuments);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await poll(
    async () => (await page.locator(".document-card").count()) === 4,
    "document list recovers on retry",
  );
  if (await page.getByRole("button", { name: "关闭提示", exact: true }).count())
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  steps.push(
    "document endpoint failures show an error instead of an empty library, and retry recovers",
  );

  await summaryCategory.click();
  await page.getByRole("button", { name: "导入资料", exact: true }).click();
  await page
    .locator("input[type=file]:not([webkitdirectory])")
    .setInputFiles(path.join(fixtures, "V2_Lecture.pdf"));
  const uploaded = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/import-jobs") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "导入 1 份资料", exact: true })
    .click();
  const { job_id: importJob } = await (await uploaded).json();
  await poll(
    async () => (await get("/import-jobs/" + importJob)).done,
    "reimport completes",
  );
  await page.getByRole("button", { name: "关闭导入任务", exact: true }).click();
  assert.match(
    await page.locator(".category-nav .active").textContent(),
    /所有资料/,
  );
  assert.equal(await page.locator(".document-card").count(), 4);
  steps.push(
    "import opens the destination course library and clears the previous category filter",
  );

  const input = page.getByLabel("搜索课程资料");
  const search = async (q, mode = "全部词") => {
    await input.fill(q);
    await page.getByRole("button", { name: mode, exact: true }).click();
    const response = page.waitForResponse(
      (r) => r.url().includes("/api/search?") && r.request().method() === "GET",
    );
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await response;
    await page.locator(".result-group").first().waitFor();
  };
  const group = (name) =>
    page
      .locator(".result-group")
      .filter({ has: page.locator(".result-file strong", { hasText: name }) });
  const pane0 = page.locator('[data-reader-pane="0"]'),
    pane1 = page.locator('[data-reader-pane="1"]');
  await search("deadlock");
  await group("V2_Lecture.pdf").locator(".hit-card").first().focus();
  await page.keyboard.press("Enter");
  await pane0.locator(".pdf-highlight.active").first().waitFor();
  await pane0.getByRole("button", { name: "放大", exact: true }).click();
  await pane0.getByLabel("跳转页码").fill("12");
  await pane0.getByLabel("跳转页码").press("Enter");
  await pane0.locator('[data-page="12"] .textLayer span').first().waitFor();
  await pane0.locator(".reader-scroll").evaluate((element) => {
    element.scrollTop += 180;
  });
  await poll(async () => {
    const position = (await get("/workspace")).panes?.[0].current?.position;
    return position?.page === 12 && position.zoom > 1;
  }, "manual PDF position persistence");
  const before = (await get("/workspace")).panes[0].current.position;
  await search("indefinite blocking", "完整短语");
  await group("V2_Notes.docx").locator(".hit-card").first().click();
  await pane0.locator(".docx-table .docx-target mark").waitFor();
  await page.getByRole("button", { name: "返回阅读位置" }).click();
  await pane0.getByLabel("跳转页码").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-reader-pane="0"] [aria-label="跳转页码"]')
        ?.value === "12",
  );
  assert.equal(await input.inputValue(), "deadlock");
  assert.equal(await pane0.locator(".zoom-button").textContent(), "115%");
  await poll(async () => {
    const position = (await get("/workspace")).panes?.[0].current?.position;
    return (
      position?.page === 12 && Math.abs(position.offset - before.offset) < 0.06
    );
  }, "returned PDF offset");
  steps.push("history back restores search, manual page offset and zoom");
  await page.getByRole("button", { name: "前进阅读位置" }).click();
  await pane0.locator(".docx-table .docx-target mark").waitFor();
  await pane0.getByRole("button", { name: "收藏当前位置" }).click();
  await page.getByLabel("收藏备注").fill("V2 browser persistent note");
  await page.getByLabel("收藏标签").fill("exam, os");
  await page.getByRole("button", { name: "保存收藏", exact: true }).click();
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await page
    .locator(".workspace-header")
    .getByRole("button", { name: "收藏", exact: true })
    .click();
  const saved = page
    .locator(".saved-item")
    .filter({ hasText: "V2 browser persistent note" })
    .first();
  await saved
    .getByRole("button", { name: "在另一栏打开", exact: true })
    .click();
  await pane1.locator(".docx-table .docx-target").waitFor();
  assert.equal(
    await pane0.locator(".reader-title strong").textContent(),
    "V2_Notes.docx",
  );
  assert.equal(
    await pane1.locator(".reader-title strong").textContent(),
    "V2_Notes.docx",
  );
  const duplicateIds = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll("[id]")).map(
      (node) => node.id,
    );
    return ids.length - new Set(ids).size;
  });
  assert.equal(
    duplicateIds,
    0,
    "Same DOCX in two panes has duplicate element IDs",
  );
  const primaryScroll = await pane0
    .locator(".reader-scroll")
    .evaluate((e) => e.scrollTop);
  await pane1.locator(".reader-scroll").evaluate((e) => {
    e.scrollTop = 0;
  });
  await sleepPaint(page);
  assert.equal(
    await pane0.locator(".reader-scroll").evaluate((e) => e.scrollTop),
    primaryScroll,
  );
  steps.push("bookmark notes/tags; same-DOCX dual navigation is isolated");

  await page.getByRole("button", { name: /^课程资料/ }).click();
  await pane0.focus();
  const docCard = (name) =>
    page.locator(".document-card").filter({
      has: page.locator(".document-open strong", { hasText: name }),
    });
  await docCard("V2_Lecture.pdf").locator(".document-open").click();
  await pane0.locator(".pdf-sheet .textLayer span").first().waitFor();
  await docCard("V2_Tutorial.pdf")
    .getByRole("button", { name: "在另一栏打开" })
    .click();
  await pane1.locator(".pdf-sheet .textLayer span").first().waitFor();
  await pane0.getByRole("button", { name: "放大", exact: true }).click();
  assert.equal(await pane0.locator(".zoom-button").textContent(), "115%");
  assert.equal(await pane1.locator(".zoom-button").textContent(), "100%");
  await sleepPaint(page);
  await page.screenshot({ path: path.join(output, "01-dual-pdf.png") });
  await page.getByRole("button", { name: "关闭双栏", exact: true }).click();
  await page.getByRole("button", { name: "双文档对照", exact: true }).click();
  await pane1.locator(".pdf-sheet .textLayer span").first().waitFor();
  assert.equal(
    await pane1.locator(".reader-title strong").textContent(),
    "V2_Tutorial.pdf",
  );
  steps.push(
    "PDF/PDF independent zoom; closing/reopening preserves second pane",
  );

  await pane0.focus();
  await docCard("V2_Notes.docx")
    .getByRole("button", { name: "在另一栏打开" })
    .click();
  await pane1.locator(".docx-sheet").waitFor();
  await poll(
    async () => !!(await get("/workspace")).panes?.[1].current?.position?.key,
    "DOCX initial location ready",
  );
  await sleepPaint(page);
  await pane1.locator(".reader-scroll").evaluate((e) => {
    e.scrollTop = 400;
  });
  await sleepPaint(page);
  const expectedKey = await pane1
    .locator(".reader-scroll")
    .evaluate((scroller) => {
      const top = scroller.getBoundingClientRect().top;
      return Array.from(scroller.querySelectorAll("[data-unit-id]")).find(
        (node) => node.getBoundingClientRect().bottom > top + 1,
      )?.dataset.unitKey;
    });
  assert(expectedKey, "A visible paragraph must have a structural key");
  await poll(
    async () =>
      (await get("/workspace")).panes?.[1].current?.position?.key ===
      expectedKey,
    "scrolled DOCX position saved",
  );
  const savedSecond = (await get("/workspace")).panes[1].current.position;
  debugExpected = savedSecond;
  const assertVisibleLocation = async (key) => {
    await page.waitForFunction((expected) => {
      const scroller = document.querySelector(
        '[data-reader-pane="1"] .reader-scroll',
      );
      if (!scroller?.clientHeight) return false;
      const top = scroller.getBoundingClientRect().top;
      const first = Array.from(
        scroller.querySelectorAll("[data-unit-id]"),
      ).find((node) => node.getBoundingClientRect().bottom > top + 1);
      return first?.dataset.unitKey === expected;
    }, key);
  };

  await page.setViewportSize({ width: 1024, height: 768 });
  await sleepPaint(page);
  assert((await pane1.isVisible()) && !(await pane0.isVisible()));
  await page
    .locator(".pane-tabs")
    .getByRole("button", { name: "阅读区 1" })
    .click();
  assert((await pane0.isVisible()) && !(await pane1.isVisible()));
  await page
    .locator(".pane-tabs")
    .getByRole("button", { name: "阅读区 2" })
    .click();
  await assertVisibleLocation(savedSecond.key);
  await page.screenshot({ path: path.join(output, "02-narrow-tabs.png") });
  await page.reload();
  await pane1.locator(".docx-sheet").waitFor();
  await poll(
    async () =>
      (await get("/workspace")).panes?.[1].current?.position?.key ===
      savedSecond.key,
    "reloaded DOCX location",
  );
  await assertVisibleLocation(savedSecond.key);
  assert.equal(await pane0.locator(".zoom-button").textContent(), "115%");
  steps.push("PDF/DOCX narrow-screen tabs and refresh persistence");

  // Current-file scope follows the active reader, rather than the previously active file.
  await page.getByLabel("搜索范围").selectOption("document");
  await page
    .locator(".pane-tabs")
    .getByRole("button", { name: "阅读区 1" })
    .click();
  await search("deadlock");
  assert.equal(await page.locator(".result-group").count(), 1);
  assert.equal(
    await page.locator(".result-file strong").textContent(),
    "V2_Lecture.pdf",
  );
  await page.getByLabel("搜索范围").selectOption("course");
  await input.fill("deadlock");
  await page.getByRole("button", { name: "查看扩展词", exact: true }).click();
  await page.getByText("直接扩展：deadlocks（词形）").waitFor();
  await page.getByLabel("本地词形与同义词").check();
  await search("deadlock");
  await page
    .locator(".match-sources")
    .filter({ hasText: "词形：deadlocks" })
    .first()
    .waitFor();
  steps.push(
    "current-file scope follows active pane; expansion preview and match labels",
  );

  await page
    .locator(".workspace-header")
    .getByRole("button", { name: "快捷键", exact: true })
    .click();
  const shortcutInput = page.getByLabel("收藏当前位置快捷键");
  await shortcutInput.focus();
  await shortcutInput.press("Control+Shift+b");
  await page
    .getByRole("button", { name: "保存快捷键与排序", exact: true })
    .click();
  await page.getByRole("button", { name: "关闭快捷键与搜索设置" }).click();
  await pane0.focus();
  await page.keyboard.press("Control+Shift+b");
  await page.getByLabel("收藏备注").waitFor();
  await page.getByRole("button", { name: "关闭收藏当前位置" }).click();
  await input.focus();
  await input.press("Alt+ArrowLeft");
  assert(await input.evaluate((e) => document.activeElement === e));
  steps.push("configurable shortcut; editable fields retain keyboard behavior");

  await page
    .locator(".workspace-header")
    .getByRole("button", { name: "自检", exact: true })
    .click();
  await page.getByRole("button", { name: "执行考前自检", exact: true }).click();
  await page.getByText("阻断问题 0", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "进入考试模式并冻结资料", exact: true })
    .click();
  await page
    .getByText("考试模式已开启。搜索、阅读和个人标注可用，资料与设置已冻结。")
    .waitFor();
  await page.getByRole("button", { name: "关闭考试自检" }).click();
  assert(
    await page
      .getByRole("button", { name: "导入资料", exact: true })
      .isDisabled(),
  );
  const docs = await get("/documents?course_id=" + course.id);
  const blocked = await page.request.post(
    base + "/api/documents/" + docs[0].id + "/rebuild",
    { headers: { "X-Local-Request": "1" } },
  );
  assert.equal(blocked.status(), 409);
  await page.reload();
  await page.getByText("考试模式 · 资料已冻结", { exact: true }).waitFor();
  await pane0.focus();
  await page.keyboard.press("Control+Shift+b");
  await page.getByLabel("收藏备注").fill("allowed during exam");
  await page.getByRole("button", { name: "保存收藏", exact: true }).click();
  await search("starvation");
  await group("V2_Lecture.pdf").locator(".hit-card").first().click();
  await pane0.locator(".pdf-highlight.active").first().waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await sleepPaint(page);
  await page.screenshot({ path: path.join(output, "03-exam.png") });
  await page
    .locator(".workspace-header")
    .getByRole("button", { name: "自检", exact: true })
    .click();
  await page.getByRole("button", { name: "退出考试模式", exact: true }).click();
  await page.getByRole("button", { name: "关闭考试自检" }).click();
  steps.push("preflight, API freeze, reload, search and bookmarks during exam");

  await page.setViewportSize({ width: 390, height: 844 });
  await sleepPaint(page);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: path.join(output, "04-mobile.png") });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify({ passed: true, steps, errors, external, output }, null, 2),
  );
  console.log(
    JSON.stringify({ passed: true, steps, errors, external, output }, null, 2),
  );
  await browser.close();
})().catch(async (error) => {
  console.error(error);
  if (debugPage) {
    await debugPage
      .screenshot({ path: path.join(output, "failure.png") })
      .catch(() => {});
    const diagnostics = await debugPage
      .evaluate(() => ({
        readers: Array.from(
          document.querySelectorAll("[data-reader-pane]"),
        ).map((node) => ({
          id: node.dataset.readerPane,
          title: node.querySelector(".reader-title strong")?.textContent,
          page: node.querySelector('[aria-label="跳转页码"]')?.value,
          scroll: node.querySelector(".reader-scroll")?.scrollTop,
        })),
        toast: document.querySelector(".toast")?.textContent,
        appCount: document.querySelectorAll(".app-shell").length,
      }))
      .catch(() => ({}));
    console.error(JSON.stringify({ ...diagnostics, expected: debugExpected }));
  }
  await debugBrowser?.close();
  process.exit(1);
});
