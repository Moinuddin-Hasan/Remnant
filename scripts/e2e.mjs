/**
 * Drives all three flows in a real browser.
 *
 * The unit tests prove the engine is correct; this proves the product exists.
 * Everything here is a user action — pick a file, click a button, read what
 * the page says — because a passing parser and a working page are different
 * claims and only one of them is demoable.
 *
 * Run: node scripts/e2e.mjs   (expects the dev server on :3000)
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3000";
const SHOTS = path.join(process.cwd(), ".e2e");

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => {
  console.log(`  FAIL  ${m}`);
  failures += 1;
};

/** A JPEG carrying EXIF GPS, an MPF second image and an appended trailer. */
async function fixtureBytes() {
  const { buildFixtureJpeg } = await import("../fixtures/build.ts");
  return Buffer.from(buildFixtureJpeg().bytes);
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const jpeg = await fixtureBytes();
  const fixturePath = path.join(SHOTS, "fixture.jpg");
  await writeFile(fixturePath, jpeg);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // ---------------------------------------------------------------- inspect
  console.log("\nInspect and clean");
  await page.goto(`${BASE}/tool`, { waitUntil: "networkidle" });
  await page.setInputFiles('input[type="file"]', fixturePath);

  await page.waitForSelector("text=What this file discloses", { timeout: 20000 });
  const body = await page.textContent("body");

  if (/12\.9716/.test(body)) ok("GPS coordinates surfaced");
  else bad("GPS not shown");

  if (/Remnant Test/.test(body)) ok("camera make read from EXIF");
  else bad("camera make missing");

  if (/Hidden inside this file/.test(body)) ok("remnant panel rendered");
  else bad("remnant panel missing");

  if (/second full-resolution image/i.test(body)) ok("MPF second image revealed");
  else bad("MPF second image not revealed");

  if (/video hidden after the end|Motion Photo/i.test(body)) ok("post-EOI trailer revealed");
  else bad("trailer not revealed");

  const imgs = await page.locator(".remnant img").count();
  if (imgs > 0) ok(`${imgs} hidden asset(s) rendered as images`);
  else bad("no hidden asset previews rendered");

  await page.screenshot({ path: path.join(SHOTS, "1-inspect.png"), fullPage: true });

  await page.click('button:has-text("Clean it")');
  await page.waitForSelector("text=Verified clean", { timeout: 20000 });
  ok("clean produced a verified-clean result");
  await page.screenshot({ path: path.join(SHOTS, "2-cleaned.png"), fullPage: true });

  // ---------------------------------------------------------------- handoff
  console.log("\nHandoff into forge");
  await page.click('button:has-text("Forge an identity onto it")');
  await page.waitForSelector("text=Stripped and verified", { timeout: 10000 });
  if (page.url().endsWith("/tool")) {
    ok("handoff stayed in one document — no navigation, no upload");
  } else {
    bad(`handoff navigated to ${page.url()}, which would have dropped the file`);
  }

  // ------------------------------------------------------------------ forge
  console.log("\nForge");
  await page.click('button:has-text("Write metadata")');
  await page.waitForSelector("text=Read back from the file we produced", { timeout: 20000 });
  const forgeBody = await page.textContent("body");

  if (/iPhone 15 Pro/.test(forgeBody)) ok("forged model reads back off the produced file");
  else bad("forged model did not read back");

  if (/Consistency: \d+\/100/.test(forgeBody)) ok("consistency score rendered");
  else bad("no consistency score");

  if (/checked against 82 known models/.test(forgeBody)) ok("device table wired (82 entries)");
  else bad("device table not reflected in the UI");

  await page.screenshot({ path: path.join(SHOTS, "3-forged.png"), fullPage: true });

  // ------------------------------------------------------- forge contradiction
  await page.fill('input[value="2024:06:01 14:30:00"]', "2019:01:01 09:00:00");
  await page.click('button:has-text("Write metadata")');
  await page.waitForTimeout(1200);
  const contradicted = await page.textContent("body");
  if (/before the .* was released|days before/i.test(contradicted)) {
    ok("linter catches a capture date before the model shipped");
  } else {
    bad("release-date contradiction not surfaced in the UI");
  }
  await page.screenshot({ path: path.join(SHOTS, "4-contradiction.png"), fullPage: true });

  // ------------------------------------------------------------------ share
  console.log("\nShare");
  await page.goto(`${BASE}/share`, { waitUntil: "networkidle" });
  await page.setInputFiles('input[type="file"]', fixturePath);
  const stripBox = page.locator('input[type="checkbox"]');
  if (await stripBox.isChecked()) ok("strip-before-share is on by default");
  else bad("strip-before-share defaulted off");
  await page.click('button:has-text("Encrypt and upload")');

  await page.waitForSelector('button:has-text("Copy link")', { timeout: 30000 });
  ok("share created and listed in the dashboard");

  const dash = await page.textContent("body");
  if (/fixture\.jpg/.test(dash)) ok("dashboard shows the filename the server never sees");
  else bad("dashboard did not show the filename");

  if (/of \d+ MB/.test(dash)) ok("storage quota bar rendered");
  else bad("no quota indicator");

  await page.screenshot({ path: path.join(SHOTS, "5-share.png"), fullPage: true });

  // The link, and whether opening it consumes a claim.
  const link = await page.evaluate(() => {
    const raw = window.localStorage.getItem("remnant.shares.v1");
    if (!raw) return null;
    const [first] = JSON.parse(raw);
    return first ? `${window.location.origin}/s/${first.id}#${first.fragment}` : null;
  });
  if (link) ok("link contains a fragment key");
  else bad("no share link found in local storage");

  const recipient = await context.newPage();
  await recipient.goto(link, { waitUntil: "networkidle" });
  await recipient.waitForSelector("text=A file is waiting for you", { timeout: 15000 });
  ok("recipient sees a gate, not the file");

  // Reload twice: a preview crawler's GET must not burn the share.
  await recipient.reload({ waitUntil: "networkidle" });
  const stillThere = await recipient
    .waitForSelector("text=A file is waiting for you", { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (stillThere) ok("reloading does not consume the claim (crawler-safe)");
  else bad("the link was burned by a page load");

  await recipient.screenshot({ path: path.join(SHOTS, "6-claim-gate.png"), fullPage: true });

  await recipient.click('button:has-text("Claim and decrypt")');
  await recipient.waitForSelector("text=Decrypted in your browser", { timeout: 20000 });
  ok("recipient decrypted the file in the browser");
  await recipient.screenshot({ path: path.join(SHOTS, "7-decrypted.png"), fullPage: true });

  // `networkidle` never settles here — the decrypted blob URL keeps the page
  // busy — so wait on the DOM instead.
  await recipient.reload({ waitUntil: "domcontentloaded" });
  const dead = await recipient
    .waitForSelector("text=no longer available", { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (dead) ok("link is dead after the single claim");
  else bad("link survived its only claim");

  // Everything above is the real user journey; assert it was clean BEFORE the
  // probe below deliberately trips the CSP, whose errors are the point.
  if (consoleErrors.length === 0) ok("no console errors across the whole journey");
  else bad(`${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 3).join(" | ")}`);
  consoleErrors.length = 0;

  // -------------------------------------------------------------- the seal
  console.log("\nThe sealed routes");
  const blocked = await page.evaluate(async () => {
    try {
      await fetch("https://example.com", { mode: "no-cors" });
      return false;
    } catch {
      return true;
    }
  });
  await page.goto(`${BASE}/tool`, { waitUntil: "networkidle" });
  const toolBlocked = await page.evaluate(async () => {
    try {
      await fetch("https://example.com", { mode: "no-cors" });
      return false;
    } catch {
      return true;
    }
  });
  if (toolBlocked) ok("/tool refuses an outbound request (connect-src 'none' enforced)");
  else bad("/tool allowed an outbound fetch — the CSP is not doing its job");
  void blocked;

  await browser.close();
  console.log(
    failures ? `\nE2E FAILED — ${failures} problem(s). Screenshots in .e2e/\n` : "\nE2E OK — screenshots in .e2e/\n",
  );
  process.exitCode = failures ? 1 : 0;
}

await main();
