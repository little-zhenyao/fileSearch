// Optional browser verification: install Playwright separately or provide NODE_PATH.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const base = process.env.FILESEARCH_TEST_URL || 'http://127.0.0.1:8766';
const root = path.resolve(__dirname, '..');
const output = process.env.FILESEARCH_TEST_OUTPUT || path.join(root, '.local', 'browser-qa');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = route.request().url();
    if (!url.startsWith(base + '/') && !url.startsWith('data:') && !url.startsWith('blob:')) {
      external.push(url); return route.abort();
    }
    return route.continue();
  });
  await page.goto(base);
  const configured = await (await page.request.get(base + '/api/settings')).json();
  if (!configured.configured) {
    await page.getByText('选择你的资料库目录', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, '01-setup.png') });
    await page.getByLabel('选择你的资料库目录').fill(process.env.FILESEARCH_TEST_LIBRARY || path.join(root, '.local', 'qa', 'library'));
    await page.getByRole('button', { name: '创建资料库，开始使用' }).click();
  }
  const courses = await (await page.request.get(base + '/api/courses')).json();
  if (!courses.length) {
    await page.getByRole('button', { name: '新建课程', exact: true }).click();
    await page.getByLabel('课程名称').fill('CS2106 操作系统');
    await page.getByRole('button', { name: '创建课程', exact: true }).click();
  }
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  const sampleDir = path.join(root, '.local', 'samples');
  const files = fs.readdirSync(sampleDir).filter(name => /\.(pdf|docx)$/.test(name)).map(name => path.join(sampleDir, name));
  await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(files);
  const uploadResponse = page.waitForResponse(response => response.url().endsWith('/api/import-jobs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: `导入 ${files.length} 份资料`, exact: true }).click();
  const { job_id } = await (await uploadResponse).json();
  await page.waitForFunction(async id => (await (await fetch('/api/import-jobs/' + id)).json()).done, job_id, { timeout: 30000 });
  await page.locator(`[data-job="${job_id}"]`).getByText(`${files.length} / ${files.length} 已处理`).waitFor({ timeout: 30000 });
  await page.screenshot({ path: path.join(output, '02-import.png') });
  await page.getByRole('button', { name: '关闭导入任务' }).click();
  // V2 persists its workspace: make this legacy exact-search regression independent
  // of a previous comparison session or an enabled expansion preference.
  const closeComparison = page.getByRole('button', { name: '关闭双栏', exact: true });
  if (await closeComparison.count()) await closeComparison.click();
  const expansion = page.getByLabel('本地词形与同义词');
  if (await expansion.count()) await expansion.uncheck();
  const scope = page.getByLabel('搜索范围');
  if (await scope.count()) await scope.selectOption('course');
  const input = page.getByLabel('搜索课程资料');
  await input.fill('deadlock'); await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.locator('.result-group').first().waitFor();
  const group = page.locator('.result-group').filter({ hasText: 'Lecture07_Deadlocks.pdf' });
  const pdfStart = Date.now();
  await group.locator('.hit-card').first().click();
  await page.locator('.pdf-highlight.active').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.pdf-sheet .textLayer span') !== null);
  const pdfOpenMs = Date.now() - pdfStart;
  await page.screenshot({ path: path.join(output, '03-pdf.png') });
  const metrics = await page.evaluate(() => {
    const highlight = document.querySelector('.pdf-highlight.active').getBoundingClientRect();
    const spans = Array.from(document.querySelectorAll('.pdf-sheet[data-page="1"] .textLayer span'));
    const target = spans.find(span => /\bdeadlock\b/i.test(span.textContent));
    let text;
    if (target?.firstChild) {
      const match = target.textContent.match(/\bdeadlock\b/i);
      const range = document.createRange();
      range.setStart(target.firstChild, match.index); range.setEnd(target.firstChild, match.index + match[0].length);
      text = range.getBoundingClientRect();
    }
    return { highlight: { x: highlight.x, y: highlight.y, width: highlight.width, height: highlight.height },
      target: text ? { x: text.x, y: text.y, width: text.width, height: text.height } : null };
  });
  assert(metrics.target, 'PDF text layer missing');
  // The matching word must overlap its source line vertically.
  assert(metrics.highlight.y < metrics.target.y + metrics.target.height + 5 && metrics.highlight.y + metrics.highlight.height > metrics.target.y - 5, 'Highlight is not aligned with PDF text');
  assert(Math.abs(metrics.highlight.x - metrics.target.x) < 4, 'Highlight x position is incorrect');
  assert(Math.abs(metrics.highlight.width - metrics.target.width) < 4, 'Text selection layer and highlight widths differ');
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await page.getByRole('button', { name: '顺时针旋转' }).click();
  await page.locator('.pdf-highlight.active').first().waitFor();
  await page.screenshot({ path: path.join(output, '04-rotated.png') });
  await input.fill('indefinite blocking');
  await page.getByRole('button', { name: '完整短语', exact: true }).click();
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const docxStart = Date.now();
  await page.locator('.result-group').filter({ hasText: 'Summary_Concepts.docx' }).locator('.hit-card').first().click();
  await page.locator('.docx-table .docx-target mark').waitFor();
  const docxOpenMs = Date.now() - docxStart;
  await page.screenshot({ path: path.join(output, '05-docx.png') });
  assert.equal(await page.locator('.docx-target mark').textContent(), 'Indefinite blocking');
  await input.fill('死锁'); await page.getByRole('button', { name: '全部词', exact: true }).click();
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.locator('.result-group').filter({ hasText: 'Mixed_Chinese_English.pdf' }).waitFor();
  await page.locator('.result-group').filter({ hasText: 'Mixed_Chinese_English.pdf' }).locator('.hit-card').first().click();
  await page.locator('.pdf-highlight.active').first().waitFor();
  await page.screenshot({ path: path.join(output, '06-chinese.png') });
  await page.reload();
  await page.getByRole('button', { name: /^课程资料/ }).click();
  await page.locator('.document-card').first().waitFor();
  assert((await page.locator('.document-card').count()) >= 9);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(output, '07-laptop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, '08-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Mobile horizontal overflow');
  assert.deepEqual(external, [], 'External network requests found');
  assert.deepEqual(errors, [], 'Browser runtime errors found');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, external, errors, metrics, pdfOpenMs, docxOpenMs, files: files.length }, null, 2));
  console.log(JSON.stringify({ passed: true, samples: files.length, external, errors, output }, null, 2));
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
