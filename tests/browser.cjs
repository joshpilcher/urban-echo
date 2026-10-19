/* Browser integration tests. GPS callbacks and test memories are simulated, never field evidence. */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
};
const point = { latitude: -26.6812, longitude: 153.119, accuracy: 8 };
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("PASS " + name);
}
async function main() {
  await fs.mkdir(path.join(root, "test-results/screenshots"), {recursive:true});
  const server = http.createServer(async (req, res) => {
    try {
      let file = path.join(
        root,
        decodeURIComponent(new URL(req.url, "http://localhost").pathname),
      );
      if (!file.startsWith(root + path.sep)) throw new Error("Outside root");
      if ((await fs.stat(file)).isDirectory())
        file = path.join(file, "index.html");
      res.writeHead(200, {
        "Content-Type": mime[path.extname(file)] || "text/plain",
      });
      res.end(await fs.readFile(file));
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port + "/";
  let browser;
  try {
    const proxyURL = process.env.HTTPS_PROXY || process.env.https_proxy;
    const proxy = proxyURL ? new URL(proxyURL) : null;
    browser = await chromium.launch({
      proxy: proxy
        ? {
            server: proxy.origin,
            bypass: "127.0.0.1,localhost",
            username: decodeURIComponent(proxy.username),
            password: decodeURIComponent(proxy.password),
          }
        : undefined,
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    console.log("Browser: Chromium " + browser.version());
    const offline = process.env.ECHO_TEST_OFFLINE === "1";
    const newContext = async (options) => {
      const context = await browser.newContext(options);
      if (offline) await context.route("https://**", route => route.abort());
      return context;
    };
    if (offline) console.log("Offline check: external map tiles/fonts blocked; testing local GPS/list workflow.");
    const context = await newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
    });
    // Optional web fonts must not turn a functional test into a network timeout.
    // The product's normal CSS system-font fallback is used in these captures.
    await context.route("https://fonts.googleapis.com/**", route => route.fulfill({status:200,contentType:"text/css",body:"/* system fonts for repeatable browser checks */"}));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      let next = 0;
      const callbacks = new Map(),
        retired = [];
      window.__gps = {
        callbacks,
        retired,
        started: 0,
        cleared: 0,
        emit(coords, timestamp = Date.now()) {
          for (const cb of callbacks.values())
            cb.success({ coords, timestamp });
        },
        error(code) {
          for (const cb of [...callbacks.values()]) cb.error({ code });
        },
      };
      Object.defineProperty(navigator, "geolocation", {
        value: {
          watchPosition(success, error) {
            window.__gps.started++;
            callbacks.set(++next, { success, error });
            return next;
          },
          clearWatch(id) {
            window.__gps.cleared++;
            retired.push(callbacks.get(id));
            callbacks.delete(id);
          },
        },
      });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const emit = (coords) => page.evaluate((p) => window.__gps.emit(p), coords);
    const text = (selector) => page.locator(selector).innerText();
    const save = async (title, story) => {
      await page.locator("#create").click();
      await page.locator("#title").fill(title);
      await page.locator("#story").fill(story);
      await page.locator("#echo-form button[type=submit]").click();
    };
    await check("no implicit GPS prompt and empty browser state", async () => {
      assert.equal(await page.evaluate(() => __gps.started), 0);
      assert.equal(await page.locator("#create").isDisabled(), true);
      assert.match(await text("#echo-list"), /first memory/);
    });
    await check(
      "permission denial releases watcher and retry creates exactly one watcher",
      async () => {
        await page.locator("#locate").click();
        await page.evaluate(() => __gps.error(1));
        assert.match(await text("#location-status"), /permission denied/);
        assert.equal(await page.evaluate(() => __gps.callbacks.size), 0);
        await page.locator("#locate").click();
        await page.locator("#locate").click();
        assert.equal(await page.evaluate(() => __gps.callbacks.size), 1);
        await emit(point);
        assert.equal(await page.locator("#create").isEnabled(), true);
        assert.equal(await page.locator(".user-marker").count(), 1);
      },
    );
    await check(
      "temporary GPS interruption recovers on the existing watcher",
      async () => {
        const started = await page.evaluate(() => __gps.started);
        await page.evaluate(() => __gps.error(2));
        assert.equal(await page.locator("#create").isDisabled(), true);
        assert.equal(await page.evaluate(() => __gps.callbacks.size), 1);
        await emit(point);
        assert.equal(await page.locator("#create").isEnabled(), true);
        assert.equal(await page.evaluate(() => __gps.started), started);
      },
    );
    await check(
      "save uses GPS rather than map centre; memory and coordinates persist after reload",
      async () => {
        await save(
          "Test memory · by the water",
          "Synthetic browser-test content. We stopped here to watch the light on the water.",
        );
        const records = await page.evaluate(() =>
          JSON.parse(localStorage.getItem("urban-echo-v1")),
        );
        assert.equal(records.length, 1);
        assert.equal(records[0].lat, point.latitude);
        assert.equal(records[0].lng, point.longitude);
        await page.reload({ waitUntil: "domcontentloaded" });
        assert.match(await text("#echo-list"), /Test memory/);
        assert.doesNotMatch(await text("#echo-list"), /We stopped/);
        await page.locator("#locate").click();
        await emit(point);
        assert.match(await text("#echo-list"), /We stopped/);
      },
    );
    await check(
      "physical movement simulation locks and unlocks story with accuracy uncertainty",
      async () => {
        await emit({ ...point, latitude: point.latitude + 0.002 });
        assert.match(await text(".echo-tag"), /LOCKED/);
        assert.doesNotMatch(await text("#echo-list"), /We stopped/);
        await emit({
          ...point,
          latitude: point.latitude + 0.00085,
          accuracy: 15,
        });
        assert.match(await text(".echo-tag"), /CHECKING GPS/);
        assert.doesNotMatch(await text("#echo-list"), /We stopped/);
        await emit(point);
        assert.match(await text(".echo-tag"), /UNLOCKED/);
        await page.locator("#filter-unlocked").click();
        await emit({ ...point, latitude: point.latitude + 0.002 });
        assert.equal(await page.locator(".echo").count(), 0);
        assert.match(await text("#echo-list"), /Nothing within reach/);
        await page.locator("#filter-all").click();
        await emit(point);
      },
    );
    await check("poor GPS disables creation and prevents unlock", async () => {
      await emit({ ...point, accuracy: 200 });
      assert.equal(await page.locator("#create").isDisabled(), true);
      assert.match(await text(".echo-tag"), /CHECKING GPS/);
      await emit(point);
    });
    await check(
      "draft survives GPS failure, rejects save until recovered, then saves at latest position",
      async () => {
        await page.locator("#create").click();
        await page.locator("#title").fill("A moving draft");
        await page.locator("#story").fill("Draft preserved.");
        await page.evaluate(() => __gps.error(3));
        await page.locator("#echo-form button[type=submit]").click();
        assert.match(await text("#form-error"), /fresh GPS/);
        assert.equal(
          await page.locator("#title").inputValue(),
          "A moving draft",
        );
        await page.locator("#close").click();
        await page.locator("#locate").click();
        await emit({ ...point, longitude: point.longitude + 0.001 });
        await page.locator("#create").click();
        await page.locator("#echo-form button[type=submit]").click();
        assert.equal(
          await page.evaluate(
            () => JSON.parse(localStorage.getItem("urban-echo-v1"))[0].lng,
          ),
          point.longitude + 0.001,
        );
      },
    );
    await check(
      "stop clears location, relocks memories and ignores queued old callbacks",
      async () => {
        await page.locator("#stop").click();
        assert.equal(await page.evaluate(() => __gps.callbacks.size), 0);
        assert.equal(await page.locator(".user-marker").count(), 0);
        assert.equal(await page.locator("#create").isDisabled(), true);
        assert.doesNotMatch(await text("#echo-list"), /Draft preserved/);
        await page.evaluate(
          (p) =>
            __gps.retired.at(-1).success({ coords: p, timestamp: Date.now() }),
          point,
        );
        assert.equal(await page.locator("#create").isDisabled(), true);
      },
    );
    await check(
      "HTML in user title renders as text in both card and Leaflet tooltip",
      async () => {
        await page.locator("#locate").click();
        await emit(point);
        await save(
          '<img src=x onerror="window.injected=true">',
          "A text-only test.",
        );
        await page.locator(".echo").first().click();
        assert.equal(await page.locator(".leaflet-tooltip img").count(), 0);
        assert.equal(await page.evaluate(() => window.injected), undefined);
        assert.match(await text(".leaflet-tooltip"), /<img/);
      },
    );
    await check(
      "storage quota failure preserves form draft without adding memory",
      async () => {
        const before = await page.locator(".echo").count();
        await page.locator("#create").click();
        await page.locator("#title").fill("Quota test");
        await page.locator("#story").fill("Do not lose this draft.");
        await page.evaluate(() => {
          window.__setItem = Storage.prototype.setItem;
          Storage.prototype.setItem = () => {
            throw new DOMException("Full", "QuotaExceededError");
          };
        });
        await page.locator("#echo-form button[type=submit]").click();
        assert.match(await text("#form-error"), /not saved/);
        assert.equal(
          await page.locator("#story").inputValue(),
          "Do not lose this draft.",
        );
        assert.equal(await page.locator(".echo").count(), before);
        await page.evaluate(() => {
          Storage.prototype.setItem = window.__setItem;
        });
        await page.locator("#close").click();
      },
    );
    await check(
      "malformed saved data is preserved and cannot be overwritten by creation",
      async () => {
        await page.evaluate(() => {
          localStorage.setItem("urban-echo-v1", "broken-json");
          window.dispatchEvent(
            new StorageEvent("storage", { key: "urban-echo-v1" }),
          );
        });
        assert.match(await text("#storage-note"), /could not be read/);
        assert.equal(await page.locator("#create").isDisabled(), true);
        assert.equal(
          await page.evaluate(() => localStorage.getItem("urban-echo-v1")),
          "broken-json",
        );
        await page.evaluate(() => {
          localStorage.removeItem("urban-echo-v1");
          window.dispatchEvent(
            new StorageEvent("storage", { key: "urban-echo-v1" }),
          );
        });
      },
    );
    await check(
      "mobile form and layout fit 320, 390, 768 and desktop 1440 pixel widths",
      async () => {
        for (const width of [320, 390, 768, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
            "page width " + width,
          );
          await emit(point);
          await page.locator("#create").click();
          assert.equal(
            await page.evaluate(() => {
              const d = document
                .querySelector("dialog")
                .getBoundingClientRect();
              return d.left >= 0 && d.right <= innerWidth;
            }),
            true,
            "dialog width " + width,
          );
          await page.locator("#close").click();
        }
      },
    );
    // Capture real browser renders using synthetic content, clearly labelled in the journal.
    const fixtures = [
      {
        id: "test-water",
        title: "A quiet moment by the water",
        story:
          "Browser-test fixture: a memory of watching the sunset after a long walk.",
        lat: point.latitude,
        lng: point.longitude,
        createdAt: "2026-10-19T04:00:00Z",
      },
      {
        id: "test-walk",
        title: "Where the walk began",
        story: "Browser-test fixture: this story is hidden until approached.",
        lat: point.latitude + 0.002,
        lng: point.longitude + 0.001,
        createdAt: "2026-10-19T04:05:00Z",
      },
    ];
    await page.evaluate((records) => {
      localStorage.setItem("urban-echo-v1", JSON.stringify(records));
      window.dispatchEvent(
        new StorageEvent("storage", { key: "urban-echo-v1" }),
      );
    }, fixtures);
    await page.setViewportSize({ width: 390, height: 844 });
    await emit(point);
    await page.evaluate(() => {
      const b = document.createElement("div");
      b.id = "test-banner";
      b.textContent = "SIMULATED GPS · BROWSER TEST";
      b.style =
        "position:fixed;top:0;left:0;right:0;z-index:20000;background:#f3ce8e;color:#15262d;text-align:center;font:700 10px system-ui;padding:4px;pointer-events:none";
      document.body.append(b);
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    if (!offline) await page.waitForFunction(() => {
      const tiles = [...document.querySelectorAll(".leaflet-tile")];
      return tiles.length > 0 && tiles.every(tile => tile.complete && tile.naturalWidth > 0);
    }, null, {timeout:12000}).then(() => console.log("CAPTURE: basemap loaded"), () => console.log("CAPTURE: basemap pending or unavailable; GPS/list capture continues"));
    await emit(point);
    await page.screenshot({
      path: path.join(root, "test-results/screenshots/iteration-02-mobile.png"),
      fullPage: true,
    });
    await page.locator("#create").click();
    await page.locator("#title").fill("The start of something");
    await page
      .locator("#story")
      .fill("Browser-test draft: a memory pinned to this GPS location.");
    await page.locator("#dialog").evaluate((dialog) => {
      const note = document.createElement("p");
      note.id = "dialog-test-banner";
      note.textContent = "SIMULATED GPS · BROWSER TEST";
      note.style = "color:#f3ce8e;font:700 10px system-ui;margin:0 0 12px";
      dialog.prepend(note);
    });
    await page.screenshot({
      path: path.join(root, "test-results/screenshots/iteration-02-create.png"),
      fullPage: false,
    });
    await page.locator("#dialog-test-banner").evaluate((el) => el.remove());
    await page.locator("#close").click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await emit({ ...point, latitude: point.latitude + 0.002 });
    await page.evaluate(() => window.scrollTo(0, 0));
    if (!offline) await page.waitForFunction(() => {
      const tiles = [...document.querySelectorAll(".leaflet-tile")];
      return tiles.length > 0 && tiles.every(tile => tile.complete && tile.naturalWidth > 0);
    }, null, {timeout:12000}).then(() => console.log("CAPTURE: basemap loaded"), () => console.log("CAPTURE: basemap pending or unavailable; GPS/list capture continues"));
    await emit({ ...point, latitude: point.latitude + 0.002 });
    await page.screenshot({
      path: path.join(root, "test-results/screenshots/iteration-02-desktop.png"),
      fullPage: true,
    });
    await check(
      "fresh fix expires after 30 seconds and old incoming fix is rejected",
      async () => {
        await page.clock.install();
        await emit(point);
        await page.clock.fastForward(30001);
        assert.equal(await page.locator("#create").isDisabled(), true);
        assert.match(await text("#location-status"), /refreshing/);
        await page.evaluate((p) => __gps.emit(p, Date.now() - 31000), point);
        assert.equal(await page.locator("#create").isDisabled(), true);
        await emit(point);
        assert.equal(await page.locator("#create").isEnabled(), true);
      },
    );
    await check("application throws no uncaught browser errors", async () =>
      assert.deepEqual(errors, []),
    );
    await context.close();
    await check(
      "browser geolocation API integration starts and responds to changed coordinates",
      async () => {
        const native = await newContext({
          ignoreHTTPSErrors: true,
          permissions: ["geolocation"],
          geolocation: point,
        });
        const tab = await native.newPage();
        tab.setDefaultTimeout(10000);
        tab.setDefaultNavigationTimeout(20000);
        await tab.goto(url, { waitUntil: "domcontentloaded" });
        await tab.locator("#locate").click();
        await tab
          .locator("#location-status")
          .filter({ hasText: "Your location is active" })
          .waitFor();
        assert.equal(await tab.locator("#create").isEnabled(), true);
        await native.setGeolocation({
          ...point,
          latitude: point.latitude + 0.002,
        });
        await tab
          .locator("#location-status")
          .filter({ hasText: "Your location is active" })
          .waitFor();
        await tab.locator("#create").click();
        assert.match(
          await tab.locator("#save-location").innerText(),
          /-26.67920/,
        );
        await native.close();
      },
    );
    await check(
      "GPS and creation still work when the Leaflet script fails to load",
      async () => {
        const fallback = await newContext({
          ignoreHTTPSErrors: true,
          permissions: ["geolocation"],
          geolocation: point,
        });
        await fallback.route("**/leaflet.js", (route) => route.abort());
        const tab = await fallback.newPage();
        tab.setDefaultTimeout(10000);
        tab.setDefaultNavigationTimeout(20000);
        await tab.goto(url, { waitUntil: "domcontentloaded" });
        assert.match(
          await tab.locator("#map-notice").innerText(),
          /could not load/,
        );
        await tab.locator("#locate").click();
        await tab
          .locator("#location-status")
          .filter({ hasText: "Your location is active" })
          .waitFor();
        assert.equal(await tab.locator("#create").isEnabled(), true);
        await fallback.close();
      },
    );
    console.log(
      "RESULT: " +
        passed +
        " browser checks passed. GPS and content were simulated; physical-device testing remains outstanding.",
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
