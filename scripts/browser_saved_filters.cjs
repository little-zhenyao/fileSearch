// Run against an explicitly named isolated test library, never personal materials.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const base = process.env.FILESEARCH_TEST_URL || "http://127.0.0.1:8767";
const library = process.env.FILESEARCH_TEST_LIBRARY;
if (!library)
  throw new Error("Set FILESEARCH_TEST_LIBRARY to the isolated test library.");

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const get = async (route) => {
      const response = await page.request.get(base + "/api" + route);
      assert(response.ok(), await response.text());
      return response.json();
    };
    const post = async (route, data) => {
      const response = await page.request.post(base + "/api" + route, {
        headers: { "X-Local-Request": "1" },
        data,
      });
      assert(response.ok(), await response.text());
      return response.json();
    };
    const settings = await get("/settings");
    assert(settings.configured);
    assert.equal(
      path.resolve(settings.library_path),
      path.resolve(library),
      "Refusing to modify another library",
    );
    await post("/exam/exit", {});
    const reset = await page.request.put(base + "/api/workspace", {
      headers: { "X-Local-Request": "1" },
      data: {},
    });
    assert(reset.ok());
    const course = await post("/courses", {
      name: "Saved filter regression " + Date.now(),
    });
    const upload = await page.request.post(base + "/api/import-jobs", {
      headers: { "X-Local-Request": "1" },
      multipart: {
        course_id: course.id,
        paths: JSON.stringify(["filter.pdf"]),
        files: {
          name: "filter.pdf",
          mimeType: "application/pdf",
          buffer: fs.readFileSync(
            path.join(root, ".local/v2-qa/fixtures/V2_Tutorial.pdf"),
          ),
        },
      },
    });
    assert(upload.ok(), await upload.text());
    const { job_id } = await upload.json();
    await page.goto(base);
    await page.waitForFunction(
      async (id) => (await (await fetch("/api/import-jobs/" + id)).json()).done,
      job_id,
    );
    const [doc] = await get("/documents?course_id=" + course.id);
    assert(doc);
    for (const word of ["alpha", "beta"])
      await post("/bookmarks", {
        position: {
          document_id: doc.id,
          content_hash: doc.content_hash,
          page: 1,
        },
        note: word + " filter note",
        tags: [word],
      });
    await page
      .getByRole("button", { name: course.name, exact: false })
      .first()
      .click();
    await page
      .locator(".personal-nav")
      .getByRole("button", { name: "收藏与标签", exact: true })
      .click();
    await page.getByLabel("收藏课程").selectOption(course.id);
    await page
      .locator(".saved-item")
      .filter({ hasText: "alpha filter note" })
      .waitFor();
    let markHeld, release;
    const held = new Promise((resolve) => {
      markHeld = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/api/bookmarks?*", async (route) => {
      if (new URL(route.request().url()).searchParams.get("q") !== "alpha")
        return route.continue();
      const response = await route.fetch();
      markHeld();
      await gate;
      await route.fulfill({ response });
    });
    await page.getByLabel("搜索收藏备注").fill("alpha");
    await held;
    const betaResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/bookmarks?") &&
        new URL(response.url()).searchParams.get("q") === "beta",
    );
    await page.getByLabel("搜索收藏备注").fill("beta");
    await betaResponse;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page
      .locator(".saved-item")
      .filter({ hasText: "beta filter note" })
      .waitFor();
    assert.equal(await page.locator(".saved-item").count(), 1);
    const oldResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/bookmarks?") &&
        new URL(response.url()).searchParams.get("q") === "alpha",
    );
    release();
    await oldResponse;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(await page.getByLabel("搜索收藏备注").inputValue(), "beta");
    assert.match(
      await page.locator(".saved-list").textContent(),
      /beta filter note/,
    );
    assert.doesNotMatch(
      await page.locator(".saved-list").textContent(),
      /alpha filter note/,
    );
    assert.deepEqual(errors, []);
    const output = path.join(
      root,
      ".local/v2-qa/browser/saved-filter-report.json",
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const report = {
      passed: true,
      checks: [
        "A delayed previous bookmark query cannot replace the current filter results",
      ],
      errors,
    };
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
