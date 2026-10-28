// Run after browser_v2.cjs against the same explicitly isolated library.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const base = process.env.FILESEARCH_TEST_URL || "http://127.0.0.1:8767";
const library = process.env.FILESEARCH_TEST_LIBRARY;
if (!library)
  throw new Error("Set FILESEARCH_TEST_LIBRARY to an isolated test library.");
const output = path.resolve(__dirname, "../.local/v2-qa/browser");
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
  const get = (route) => request(route, undefined, "GET");
  const poll = async (condition, label) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out: " + label);
  };
  try {
    const settings = await get("/settings");
    assert(settings.configured, "Run browser_v2.cjs first.");
    assert.equal(
      path.resolve(settings.library_path),
      path.resolve(library),
      "Refusing to mutate a different library.",
    );
    const documents = await get("/documents");
    const notes = documents.find(
      (doc) =>
        doc.name === "V2_Notes.docx" &&
        doc.course_name.startsWith("V2 validation "),
    );
    assert(
      notes,
      "Run browser_v2.cjs to import the regression fixtures first.",
    );
    await request("/exam/exit");
    await request("/workspace", {}, "PUT");
    await page.goto(base);
    await page
      .getByRole("button", { name: notes.course_name, exact: false })
      .first()
      .click();
    const input = page.getByLabel("搜索课程资料");
    await input.fill("deadlock");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const group = (name) =>
      page.locator(".result-group").filter({
        has: page.locator(".result-file strong", { hasText: name }),
      });
    const notesGroup = group("V2_Notes.docx");
    await notesGroup.locator(".more-units").waitFor();
    const before = await notesGroup.locator(".hit-card").count();
    let release,
      unitRequests = 0;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const delayUnits = async (route) => {
      if (!new URL(route.request().url()).searchParams.has("unit_offset"))
        return route.continue();
      unitRequests++;
      const response = await route.fetch();
      await gate;
      return route.fulfill({ response });
    };
    await page.route("**/api/search?*", delayUnits);
    // Two clicks while the first response is pending reproduce duplicate pages.
    await notesGroup.locator(".more-units").evaluate((button) => {
      button.click();
      button.click();
    });
    await poll(() => unitRequests > 0, "unit page request");
    await page.waitForTimeout(150);
    release();
    await poll(
      async () => (await notesGroup.locator(".hit-card").count()) > before,
      "appended unit page",
    );
    const ids = await notesGroup
      .locator(".hit-card")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.hit));
    assert.equal(
      unitRequests,
      1,
      "Concurrent clicks should request a unit page only once",
    );
    assert.equal(
      ids.length,
      new Set(ids).size,
      "Result unit pages must not contain duplicate hits",
    );
    await page.unroute("**/api/search?*", delayUnits);

    const primary = page.locator('[data-reader-pane="0"]');
    const secondary = page.locator('[data-reader-pane="1"]');
    await group("V2_Lecture.pdf").locator(".hit-card").first().click();
    await primary.locator(".pdf-highlight.active").first().waitFor();
    await primary.getByLabel("跳转页码").fill("12");
    await primary.getByLabel("跳转页码").press("Enter");
    await poll(
      async () =>
        (await get("/workspace")).panes?.[0].current?.position?.page === 12,
      "manual PDF page",
    );
    await primary
      .getByRole("button", { name: "下一个命中", exact: true })
      .click();
    await poll(
      async () =>
        (await get("/workspace")).panes?.[0].current?.position?.page === 1,
      "match button returns to offscreen hit, including single-match wrap",
    );

    await notesGroup.locator(".other-open").first().click();
    await secondary.locator(".docx-target").waitFor();
    const target = secondary.locator("[data-unit-id]").nth(30);
    await target.evaluate((node) =>
      node.scrollIntoView({ block: "start", behavior: "instant" }),
    );
    const { oldUnit, key } = await secondary
      .locator(".reader-scroll")
      .evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const visible = Array.from(
          element.querySelectorAll("[data-unit-id]"),
        ).find((node) => node.getBoundingClientRect().bottom > top + 1);
        if (!visible)
          throw new Error("No visible DOCX paragraph after scrolling");
        return {
          oldUnit: visible.dataset.unitId,
          key: visible.dataset.unitKey,
        };
      });
    assert(
      oldUnit && key,
      "The visible DOCX paragraph must have a persistent anchor",
    );
    await poll(
      async () =>
        (await get("/workspace")).panes?.[1].current?.position?.unit_id ===
        oldUnit,
      "second-pane DOCX position",
    );
    await page.getByRole("button", { name: "关闭双栏", exact: true }).click();
    await poll(
      async () => (await get("/workspace")).dual === false,
      "saved closed second pane",
    );
    let observedVersion = 0;
    const observeDocuments = async (response) => {
      if (!response.url().endsWith("/api/documents") || !response.ok()) return;
      const docs = await response.json();
      observedVersion = docs.find((doc) => doc.id === notes.id)?.version || 0;
    };
    page.on("response", observeDocuments);
    const rebuilt = await request("/documents/" + notes.id + "/rebuild", {});
    await poll(
      async () => (await get("/import-jobs/" + rebuilt.job_id)).done,
      "DOCX rebuild",
    );
    const latest = (await get("/documents")).find((doc) => doc.id === notes.id);
    assert(latest.version > notes.version);
    // Ensure the React documents list has observed the new version while pane 2 is closed.
    await poll(
      () => observedVersion === latest.version,
      "frontend documents refresh after rebuild",
    );
    await page.getByRole("button", { name: "双文档对照", exact: true }).click();
    await secondary.locator('[data-unit-key="' + key + '"]').waitFor();
    await poll(async () => {
      const position = (await get("/workspace")).panes?.[1].current?.position;
      return (
        position?.version === latest.version &&
        position.key === key &&
        position.unit_id !== oldUnit
      );
    }, "closed DOCX pane resolves its saved structural anchor after rebuild");
    page.off("response", observeDocuments);
    await page.getByRole("button", { name: "关闭双栏", exact: true }).click();
    await poll(
      async () => (await get("/workspace")).dual === false,
      "second pane saved before delayed restore",
    );
    let releaseRestore,
      restoreRequests = 0,
      delayedRestoreFinished = false;
    const restoreGate = new Promise((resolve) => {
      releaseRestore = resolve;
    });
    const delayFirstRestore = async (route) => {
      restoreRequests++;
      if (restoreRequests !== 1) return route.continue();
      const response = await route.fetch();
      await restoreGate;
      await route.fulfill({ response });
      delayedRestoreFinished = true;
    };
    await page.route("**/api/positions/resolve", delayFirstRestore);
    await page.getByRole("button", { name: "双文档对照", exact: true }).click();
    await poll(
      () => restoreRequests === 1,
      "first second-pane restore is pending",
    );
    await page.getByRole("button", { name: "关闭双栏", exact: true }).click();
    await poll(async () => {
      const state = await get("/workspace");
      return !state.dual && state.panes?.[1].saved?.position?.key === key;
    }, "closing a pending restore preserves its saved position");
    await page.getByRole("button", { name: "双文档对照", exact: true }).click();
    await poll(async () => {
      const state = await get("/workspace");
      return (
        restoreRequests >= 2 &&
        state.dual &&
        state.panes?.[1].current?.position?.key === key
      );
    }, "second restore succeeds before the first response arrives");
    const restoredVisitId = (await get("/workspace")).panes[1].current.id;
    releaseRestore();
    await poll(
      () => delayedRestoreFinished,
      "first stale restore response delivered",
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      (await get("/workspace")).panes[1].current.id,
      restoredVisitId,
      "An obsolete restore must not overwrite the newly opened visit",
    );
    await page.unroute("**/api/positions/resolve", delayFirstRestore);
    assert.equal(errors.length, 0, errors.join("\n"));
    await page.screenshot({
      path: path.join(output, "frontend-regressions.png"),
    });
    console.log(
      JSON.stringify(
        {
          passed: [
            "concurrent unit pagination does not duplicate hits",
            "match controls return to offscreen hit after manual navigation",
            "closed second pane restores DOCX structural anchor after same-content rebuild",
            "closing and reopening during a delayed restore retains the saved anchor and ignores the obsolete response",
          ],
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await page
      .screenshot({
        path: path.join(output, "frontend-regressions-failure.png"),
      })
      .catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
