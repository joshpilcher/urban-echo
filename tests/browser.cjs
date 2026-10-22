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
  await fs.mkdir(path.join(root, "test-results/screenshots"), {
    recursive: true,
  });
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
      // Regression checks stay device-only even when the app has live configuration.
      await context.route("**/config.js", (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body: "window.URBAN_ECHO_CONFIG = {};",
        }),
      );
      if (offline) await context.route("https://**", (route) => route.abort());
      return context;
    };
    if (offline)
      console.log(
        "Offline check: external map tiles/fonts blocked; testing local GPS/list workflow.",
      );
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
    await context.route("https://fonts.googleapis.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/css",
        body: "/* system fonts for repeatable browser checks */",
      }),
    );
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
      await page.locator("#dialog").waitFor({ state: "hidden" });
    };
    await check("no implicit GPS prompt and empty browser state", async () => {
      assert.equal(await page.evaluate(() => __gps.started), 0);
      assert.equal(await page.locator("[data-kind]").count(), 0);
      assert.match(await text("#map-discovery-title"), /Find a story/);
      assert.ok(
        await page
          .locator(".leaflet-tile")
          .evaluateAll((imgs) =>
            imgs.some((img) => new URL(img.src).pathname.startsWith("/13/")),
          ),
        "starting map uses the closer zoom",
      );
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
        assert.ok(
          await page
            .locator(".leaflet-tile")
            .evaluateAll((imgs) =>
              imgs.some((img) => new URL(img.src).pathname.startsWith("/17/")),
            ),
          "first GPS view uses street-level zoom",
        );
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
        await page.locator("#nav-nearby").click();
        await page.locator("#filter-unlocked").click();
        await emit({ ...point, latitude: point.latitude + 0.002 });
        assert.equal(await page.locator(".echo").count(), 0);
        assert.match(await text("#echo-list"), /No memories in this view/);
        await page.locator("#filter-all").click();
        await page.locator("#nav-map").click();
        await emit(point);
      },
    );
    await check("map markers strengthen on approach without revealing a locked story", async () => {
      await page.evaluate(()=>{window.__approachFace=document.querySelector('.echo-marker');window.__approachPin=__approachFace.closest('.leaflet-marker-icon');});
      const values=[];
      for(const metres of [600,300,150,50]) {
        await emit({...point,latitude:point.latitude+metres/111195});
        values.push(await page.locator('.echo-marker').first().evaluate(e=>({p:Number(e.dataset.proximity),width:e.getBoundingClientRect().width,opacity:Number(getComputedStyle(e).opacity)})));
        if(metres>100) assert.doesNotMatch(await text('#echo-list'),/We stopped/);
      }
      for(let i=1;i<values.length;i++) {assert.ok(values[i].p>values[i-1].p);assert.ok(values[i].width>values[i-1].width);assert.ok(values[i].opacity>values[i-1].opacity);}
      assert.equal(await page.locator('.echo-marker.is-unlocked').count(),1);
      assert.match(await text('#echo-list'),/We stopped/);
      assert.equal(await page.evaluate(()=>document.querySelector('.echo-marker')===__approachFace&&__approachFace.closest('.leaflet-marker-icon')===__approachPin),true);
      assert.equal(await page.locator('.echo-marker').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
      const hit=await page.locator('.echo-marker').evaluate(e=>e.closest('.leaflet-marker-icon').getBoundingClientRect().width);assert.ok(hit>=44);
      await emit({...point,latitude:point.latitude+.00085,accuracy:15});
      assert.equal(await page.locator('.echo-marker.is-uncertain').count(),1);
      assert.doesNotMatch(await text('#echo-list'),/We stopped/);
      await page.evaluate(()=>__gps.error(2));
      assert.equal(await page.locator('.echo-marker.is-unavailable').getAttribute('data-proximity'),'0.000');
      await emit(point);
    });
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
        await page.locator("#dialog").waitFor({ state: "hidden" });
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
        await page.locator("#locate").click();
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
      "Echo titles remain literal text without floating map title labels",
      async () => {
        await page.locator("#locate").click();
        await emit(point);
        await save(
          '<img src=x onerror="window.injected=true">',
          "A text-only test.",
        );
        await page.locator("#nav-nearby").click();
        await page.locator(".echo").first().click();
        assert.equal(await page.locator(".leaflet-tooltip img").count(), 0);
        assert.equal(await page.evaluate(() => window.injected), undefined);
        assert.equal(await page.locator(".leaflet-tooltip").count(), 0);
        assert.match(await page.locator("#detail-title").textContent(), /<img/);
        await page.locator("#detail-close").click();
        await page.locator("#nav-map").click();
        assert.equal(await page.locator(".leaflet-tooltip").count(), 0);
        assert.equal(await page.locator(".leaflet-marker-icon[title]").count(), 0);
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
      "photo validation rejects unsupported and unreadable files without losing the draft",
      async () => {
        await emit(point);
        await page.locator("#create").click();
        await page.locator("#title").fill("Photo validation draft");
        await page.locator("#story").fill("Keep this text when a photo fails.");
        await page.locator("#photo").setInputFiles({
          name: "invalid.gif",
          mimeType: "image/gif",
          buffer: Buffer.from("bad"),
        });
        await page.waitForFunction(() =>
          document.querySelector("#photo-status").textContent.includes("JPEG"),
        );
        assert.equal(
          await page.locator("#story").inputValue(),
          "Keep this text when a photo fails.",
        );
        await page.locator("#photo").setInputFiles({
          name: "broken.jpg",
          mimeType: "image/jpeg",
          buffer: Buffer.from("not an image"),
        });
        await page.waitForFunction(() =>
          document
            .querySelector("#photo-status")
            .textContent.includes("could not be opened"),
        );
        assert.equal(
          await page.locator("#visibility-public").isDisabled(),
          true,
        );
        await page.locator("#close").click();
      },
    );
    await check(
      "photo is resized and re-encoded, persists separately from text, and relocks in open detail",
      async () => {
        const png = await page.evaluate(() => {
          const c = document.createElement("canvas");
          c.width = 2000;
          c.height = 1000;
          const x = c.getContext("2d");
          x.fillStyle = "#087d81";
          x.fillRect(0, 0, 2000, 1000);
          x.fillStyle = "#fff";
          x.font = "72px sans-serif";
          x.fillText("SYNTHETIC PHOTO TEST", 100, 500);
          return c.toDataURL("image/png").split(",")[1];
        });
        await page.locator("#create").click();
        await page.locator("#title").fill("Synthetic photo memory");
        await page
          .locator("#story")
          .fill("A generated test image, never a field-test photograph.");
        await page.locator("#photo").setInputFiles({
          name: "fixture.png",
          mimeType: "image/png",
          buffer: Buffer.from(png, "base64"),
        });
        await page.locator("#photo-preview").waitFor({ state: "visible" });
        await page.locator("#dialog").evaluate((dialog) => {
          const p = document.createElement("p");
          p.id = "photo-test-label";
          p.textContent = "SIMULATED GPS · SYNTHETIC PHOTO TEST";
          p.style = "color:#975d20;font:700 10px system-ui";
          dialog.prepend(p);
        });
        await page.locator("#photo-preview").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(
            root,
            "test-results/screenshots/iteration-07-photo-create.png",
          ),
        });
        await page.locator("#photo-test-label").evaluate((el) => el.remove());
        await page.locator("#save-echo").click();
        await page.locator("#dialog").waitFor({ state: "hidden" });
        const stored = await page.evaluate(async () => {
          const record = JSON.parse(localStorage.getItem("urban-echo-v1"))[0];
          const blob = await EchoMedia.get(EchoCore.attachments(record)[0].id);
          const bitmap = await createImageBitmap(blob);
          return {
            record,
            type: blob.type,
            size: blob.size,
            width: bitmap.width,
            height: bitmap.height,
          };
        });
        assert.equal(stored.type, "image/jpeg");
        assert.equal(stored.width, 1600);
        assert.equal(stored.height, 800);
        assert.ok(stored.size <= 1500 * 1024);
        assert.ok(stored.record.attachments[0].id);
        assert.ok(!JSON.stringify(stored.record).includes("base64"));
        await page.reload({ waitUntil: "domcontentloaded" });
        assert.equal(await page.locator(".echo img").count(), 0);
        await page.locator("#locate").click();
        await emit(point);
        await page.locator("#nav-nearby").click();
        const card = page
          .locator(".echo")
          .filter({ hasText: "Synthetic photo memory" });
        await card.locator("img").waitFor();
        await card.click();
        assert.equal(await page.locator("#detail-image img").count(), 1);
        await page.locator("#detail-dialog").evaluate((dialog) => {
          const p = document.createElement("p");
          p.id = "photo-test-label";
          p.textContent = "SIMULATED GPS · SYNTHETIC PHOTO TEST";
          p.style =
            "color:#975d20;font:700 10px system-ui;padding:12px;margin:0";
          dialog.prepend(p);
        });
        await page.screenshot({
          path: path.join(
            root,
            "test-results/screenshots/iteration-07-photo-detail.png",
          ),
        });
        await page.locator("#photo-test-label").evaluate((el) => el.remove());
        await emit({ ...point, latitude: point.latitude + 0.002 });
        assert.equal(await page.locator("#detail-image img").count(), 0);
        assert.doesNotMatch(
          await text("#detail-story"),
          /generated test image/,
        );
        await emit(point);
        await page.locator("#detail-image img").waitFor();
        await page.locator("#delete-echo").click();
        await page.locator("#delete-yes").click();
        await page.locator("#detail-dialog").waitFor({ state: "hidden" });
        await page.waitForFunction(
          (id) => EchoMedia.get(id).then((blob) => !blob),
          stored.record.attachments[0].id,
        );
        assert.equal(
          await page
            .locator(".echo")
            .filter({ hasText: "Synthetic photo memory" })
            .count(),
          0,
        );
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
    await check(
      "map discovery prompt responds to GPS and opens the matching Nearby view",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator("#nav-map").click();
        await emit(point);
        assert.match(await text("#map-discovery-title"), /within reach/);
        await page.locator("#map-discovery-link").click();
        assert.equal(
          await page.locator("#nav-nearby").getAttribute("aria-current"),
          "page",
        );
        assert.equal(
          await page.locator("#filter-unlocked").getAttribute("aria-pressed"),
          "true",
        );
        await page.locator("#filter-all").click();
        await page.locator("#nav-map").click();
        await emit({ ...point, latitude: point.latitude + 0.02 });
        assert.match(
          await text("#map-discovery-title"),
          /No Echoes within reach/,
        );
        await page.locator("#map-discovery-link").click();
        assert.equal(
          await page.locator("#filter-all").getAttribute("aria-pressed"),
          "true",
        );
        await page.locator("#nav-map").click();
        await emit(point);
      },
    );
    await check(
      "phone map fills its content area and compact controls stay separate at all sizes",
      async () => {
        for (const size of [
          { width: 320, height: 568 },
          { width: 390, height: 844 },
          { width: 430, height: 932 },
          { width: 844, height: 390 },
        ]) {
          await page.setViewportSize(size);
          await emit(point);
          await page.locator("#nav-map").click();
          const bounds = await page.evaluate(() => {
            const r = (id) =>
              document.getElementById(id).getBoundingClientRect();
            const map = r("map"),
              layout = document
                .querySelector(".layout")
                .getBoundingClientRect(),
              create = r("create"),
              gps = document
                .querySelector(".location-panel")
                .getBoundingClientRect(),
              recenter = r("recenter"),
              prompt = r("map-discovery-link");
            return {
              pageFits:
                document.documentElement.scrollWidth <= innerWidth &&
                document.documentElement.scrollHeight <= innerHeight + 1,
              mapFills:
                map.width >= layout.width - 1 &&
                map.height >= layout.height - 1,
              promptFits: prompt.top >= map.top && prompt.bottom < gps.top,
              compactGPS: gps.height <= 52,
              createFits: create.top >= map.top && create.bottom <= map.bottom,
              recenterSeparate:
                create.right <= recenter.left && gps.bottom <= create.top,
              targets: [r("locate").height, recenter.height, create.height],
            };
          });
          for (const name of [
            "pageFits",
            "mapFills",
            "compactGPS",
            "promptFits",
            "createFits",
            "recenterSeparate",
          ])
            assert.equal(bounds[name], true, JSON.stringify({ size, bounds }));
          assert.ok(bounds.targets.every((height) => height >= 44));
          assert.equal(await page.locator("#echo-list").isVisible(), false);
          await page.locator("#locate").click();
          assert.equal(await page.locator("#stop").isVisible(), true);
          await page.locator("#location-close").click();
          assert.equal(await page.locator("#stop").isVisible(), false);
          if (size.width === 320) {
            await page.locator(".skip-link").focus();
            await page.locator(".skip-link").press("Enter");
            assert.equal(
              await page.evaluate(() => document.activeElement.id),
              "discovery",
            );
          } else await page.locator("#nav-nearby").click();
          assert.equal(
            await page.locator("#sheet-toggle").getAttribute("aria-expanded"),
            "true",
          );
          assert.equal(
            await page.locator("#nav-nearby").getAttribute("aria-current"),
            "page",
          );
          assert.equal(
            await page.locator(".location-panel").isVisible(),
            false,
          );
          await page.locator(".echo").last().scrollIntoViewIfNeeded();
          await page.locator(".echo").last().click();
          await page.locator("#detail-close").click();
          await page.locator("#nav-map").click();
        }
      },
    );
    await check(
      "mobile search, long memory close control and short create viewport remain accessible",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator("#search-toggle").click();
        await page.locator("#search").fill("quiet moment");
        assert.equal(await page.locator(".echo").count(), 1);
        await page.locator("#search-toggle").click();
        assert.equal(await page.locator(".echo").count(), 2);
        await page.evaluate(() => {
          const rows = JSON.parse(localStorage.getItem("urban-echo-v1"));
          rows[0].story = "Synthetic long-memory reading test. ".repeat(30);
          localStorage.setItem("urban-echo-v1", JSON.stringify(rows));
          dispatchEvent(new StorageEvent("storage", { key: "urban-echo-v1" }));
        });
        await emit(point);
        await page.locator("#nav-nearby").click();
        await page.locator(".echo").first().click();
        await page.locator("#detail-story").scrollIntoViewIfNeeded();
        await page
          .locator("#detail-dialog")
          .evaluate((el) => (el.scrollTop = el.scrollHeight));
        assert.equal(await page.locator("#detail-close").isVisible(), true);
        assert.ok(
          await page.locator("#detail-close").evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight;
          }),
        );
        await page.locator("#detail-close").click();
        await emit(point);
        await page.locator("#create").click();
        await page.locator("#story").focus();
        await page.setViewportSize({ width: 390, height: 420 });
        await page.locator("#save-echo").scrollIntoViewIfNeeded();
        assert.ok(
          await page.locator("#save-echo").evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight;
          }),
        );
        assert.ok(
          await page.locator("#close").evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight;
          }),
        );
        await page.locator("#close").click();
        await page.setViewportSize({ width: 390, height: 844 });
      },
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await emit(point);
    await page.locator("#nav-map").click();
    await page.evaluate(() => {
      const b = document.createElement("div");
      b.id = "test-banner";
      b.textContent = "SIMULATED GPS · BROWSER TEST";
      const shell = document.querySelector(".app");
      shell.style.marginTop = "20px";
      shell.style.height = "calc(100dvh - 20px)";
      b.style =
        "position:fixed;top:0;left:0;right:0;z-index:20000;background:#f3ce8e;color:#15262d;text-align:center;font:700 10px system-ui;padding:4px;pointer-events:none";
      document.body.append(b);
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    if (!offline)
      await page
        .waitForFunction(
          () => {
            const tiles = [...document.querySelectorAll(".leaflet-tile")];
            return (
              tiles.length > 0 &&
              tiles.every((tile) => tile.complete && tile.naturalWidth > 0)
            );
          },
          null,
          { timeout: 12000 },
        )
        .then(
          () => console.log("CAPTURE: basemap loaded"),
          () =>
            console.log(
              "CAPTURE: basemap pending or unavailable; GPS/list capture continues",
            ),
        );
    await emit(point);
    await page.screenshot({
      path: path.join(root, "test-results/screenshots/iteration-07-mobile.png"),
      fullPage: true,
    });
    await page.locator("#locate").click();
    await page.screenshot({
      path: path.join(
        root,
        "test-results/screenshots/iteration-07-location-details.png",
      ),
    });
    await page.locator("#location-close").click();
    await page.locator("#nav-nearby").click();
    await page.screenshot({
      path: path.join(root, "test-results/screenshots/iteration-07-nearby.png"),
    });
    await page.locator("#nav-map").click();
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
      path: path.join(root, "test-results/screenshots/iteration-07-create.png"),
      fullPage: false,
    });
    await page.locator("#dialog-test-banner").evaluate((el) => el.remove());
    await page.locator("#close").click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await emit({ ...point, latitude: point.latitude + 0.002 });
    await page.evaluate(() => window.scrollTo(0, 0));
    if (!offline)
      await page
        .waitForFunction(
          () => {
            const tiles = [...document.querySelectorAll(".leaflet-tile")];
            return (
              tiles.length > 0 &&
              tiles.every((tile) => tile.complete && tile.naturalWidth > 0)
            );
          },
          null,
          { timeout: 12000 },
        )
        .then(
          () => console.log("CAPTURE: basemap loaded"),
          () =>
            console.log(
              "CAPTURE: basemap pending or unavailable; GPS/list capture continues",
            ),
        );
    await emit({ ...point, latitude: point.latitude + 0.002 });
    await page.screenshot({
      path: path.join(
        root,
        "test-results/screenshots/iteration-07-desktop.png",
      ),
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
