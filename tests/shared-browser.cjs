/* Explicit live integration test. Uses synthetic GPS/image/content, two isolated
 * anonymous sessions, and the configured real Supabase service. Deletes its Echo. */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const point = { latitude: -26.6812, longitude: 153.119, accuracy: 8 };
const title = "Synthetic shared photo test " + Date.now();
let passed = 0;
async function check(name, fn) {
  await fn();
  console.log("PASS " + name);
  passed++;
}
async function main() {
  const server = http.createServer(async (req, res) => {
    try {
      let file = path.join(
        root,
        decodeURIComponent(new URL(req.url, "http://localhost").pathname),
      );
      if (!file.startsWith(root + path.sep)) throw Error("Outside root");
      if ((await fs.stat(file)).isDirectory())
        file = path.join(file, "index.html");
      const ext = path.extname(file);
      res.setHeader(
        "Content-Type",
        { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[
          ext
        ] || "application/octet-stream",
      );
      res.end(await fs.readFile(file));
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port + "/";
  let browser, a, b, record;
  try {
    const proxyText = process.env.HTTPS_PROXY || process.env.https_proxy;
    const proxy = proxyText ? new URL(proxyText) : null;
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      proxy: proxy
        ? {
            server: proxy.origin,
            bypass: "127.0.0.1,localhost",
            username: decodeURIComponent(proxy.username),
            password: decodeURIComponent(proxy.password),
          }
        : undefined,
    });
    const contexts = [];
    for (let i = 0; i < 2; i++) {
      const c = await browser.newContext({
        viewport: { width: 390, height: 844 },
        ignoreHTTPSErrors: true,
        reducedMotion: "reduce",
        isMobile: true,
        hasTouch: true,
      });
      contexts.push(c);
      // Basemap delivery is not under test; only real Supabase requests are allowed.
      await c.route("https://**", (route) =>
        new URL(route.request().url()).hostname.endsWith(".supabase.co")
          ? route.continue()
          : route.abort(),
      );
      await c.addInitScript(() => {
        let success;
        window.__emit = (p) => success?.({ coords: p, timestamp: Date.now() });
        Object.defineProperty(navigator, "geolocation", {
          value: {
            watchPosition(fn) {
              success = fn;
              return 1;
            },
            clearWatch() {
              success = null;
            },
          },
        });
      });
    }
    a = await contexts[0].newPage();
    b = await contexts[1].newPage();
    for (const page of [a, b]) {
      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(30000);
    }
    const errors = [];
    a.on("pageerror", (e) => errors.push(e.message));
    b.on("pageerror", (e) => errors.push(e.message));
    await Promise.all([a.goto(url), b.goto(url)]);
    await check(
      "real public reads work without creating a contributor account",
      async () => {
        for (const p of [a, b]) {
          await p.waitForFunction(
            () =>
              !document
                .querySelector("#community-status")
                .textContent.includes("Finding"),
          );
          assert.ok(
            !(await p.locator("#community-status").innerText()).includes(
              "unavailable",
            ),
          );
          assert.equal(await p.evaluate(() => EchoCloud.available), true);
          assert.equal(await p.evaluate(() => EchoCloud.userId), null);
        }
      },
    );
    await a.locator("#locate").click();
    await a.evaluate((p) => __emit(p), point);
    await a.locator("#create").click();
    await a.locator("#title").fill(title);
    await a
      .locator("#story")
      .fill(
        "Synthetic integration test. This is not a memory recorded on a real walk.",
      );
    const image = await a.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 1000;
      c.height = 600;
      const x = c.getContext("2d");
      x.fillStyle = "#087c80";
      x.fillRect(0, 0, 1000, 600);
      x.fillStyle = "white";
      x.font = "32px sans-serif";
      x.fillText("SYNTHETIC SHARED PHOTO TEST", 50, 300);
      return c.toDataURL("image/png").split(",")[1];
    });
    await a
      .locator("#photo")
      .setInputFiles({
        name: "synthetic.png",
        mimeType: "image/png",
        buffer: Buffer.from(image, "base64"),
      });
    await a.locator("#photo-preview").waitFor({ state: "visible" });
    await a.locator("#visibility-public").check();
    await check(
      "failed public insert preserves the photo draft for a successful retry",
      async () => {
        await a.route("**/rest/v1/urban_echoes*", (route) =>
          route.request().method() === "POST"
            ? route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({ message: "Synthetic test outage" }),
              })
            : route.continue(),
        );
        await a.evaluate((p) => __emit(p), point);
        await a.locator("#save-echo").click();
        await a
          .locator("#form-error")
          .filter({ hasText: "draft is still here" })
          .waitFor();
        assert.equal(await a.locator("#title").inputValue(), title);
        assert.equal(await a.locator("#photo-preview").isVisible(), true);
        await a.unroute("**/rest/v1/urban_echoes*");
      },
    );
    await check(
      "creator shares a real photo and row through the app",
      async () => {
        await a.evaluate((p) => __emit(p), point);
        await a.locator("#save-echo").click();
        await a.locator("#dialog").waitFor({ state: "hidden" });
        record = await a.evaluate(
          async (title) =>
            (await EchoCloud.load()).find((e) => e.title === title),
          title,
        );
        assert.ok(record?.photoPath);
        assert.equal(record.source, "shared");
        assert.equal(
          await a.evaluate(() => localStorage.getItem("urban-echo-v1")),
          null,
        );
      },
    );
    await check(
      "second session discovers shared Echo, with story/photo locked until approached",
      async () => {
        await b.locator("#refresh-shared").click();
        const card = b.locator(".echo").filter({ hasText: title });
        await card.waitFor();
        assert.equal(await card.locator("img").count(), 0);
        await card.click();
        assert.doesNotMatch(
          await b.locator("#detail-story").innerText(),
          /Synthetic integration test/,
        );
        assert.equal(await b.locator("#delete-echo").isVisible(), false);
        await b.locator("#detail-close").click();
        await b.locator("#locate").click();
        await b.evaluate((p) => __emit(p), point);
        await b.locator(".echo").filter({ hasText: title }).click();
        await b.locator("#detail-image img").waitFor();
        await b.waitForFunction(() => {
          const img = document.querySelector("#detail-image img");
          return img?.complete && img.naturalWidth > 0;
        });
        assert.match(
          await b.locator("#detail-story").innerText(),
          /Synthetic integration test/,
        );
        await b.locator("#detail-dialog").evaluate((dialog) => {
          const el = document.createElement("p");
          el.id = "test-label";
          el.textContent =
            "LIVE SHARED STORAGE · SIMULATED GPS · SYNTHETIC IMAGE";
          el.style =
            "padding:10px;margin:0;background:#f3ce8e;color:#15262d;font:700 9px system-ui";
          dialog.prepend(el);
        });
        await fs.mkdir(path.join(root, "test-results/screenshots"), {
          recursive: true,
        });
        await b.screenshot({
          path: path.join(
            root,
            "test-results/screenshots/shared-discovery.png",
          ),
        });
        await b.locator("#test-label").evaluate((el) => el.remove());
        await b.evaluate(
          (p) => __emit({ ...p, latitude: p.latitude + 0.002 }),
          point,
        );
        assert.equal(await b.locator("#detail-image img").count(), 0);
        assert.doesNotMatch(
          await b.locator("#detail-story").innerText(),
          /Synthetic integration test/,
        );
        await b.locator("#detail-close").click();
      },
    );
    await check(
      "live RLS rejects unauthenticated writes and cross-user row/photo mutations",
      async () => {
        const result = await b.evaluate(async (row) => {
          const cfg = URBAN_ECHO_CONFIG;
          const c = supabase.createClient(
            cfg.supabaseUrl,
            cfg.supabasePublishableKey,
          );
          const auth = await c.auth.signInAnonymously();
          if (auth.error) throw Error(auth.error.message);
          const forged = await c
            .from("urban_echoes")
            .insert({
              id: crypto.randomUUID(),
              owner_id: row.ownerId,
              title: "Synthetic forbidden test",
              story: "Must not be saved.",
              lat: row.lat,
              lng: row.lng,
            });
          const deleted = await c
            .from("urban_echoes")
            .delete()
            .eq("id", row.id)
            .select();
          const altered = await c
            .from("urban_echoes")
            .update({ title: "Must not change" })
            .eq("id", row.id);
          const badUpload = await c.storage
            .from("urban-echo-photos")
            .upload(
              row.ownerId + "/" + crypto.randomUUID() + ".jpg",
              new Blob(["test"], { type: "image/jpeg" }),
            );
          const badRemove = await c.storage
            .from("urban-echo-photos")
            .remove([row.photoPath]);
          const anon = supabase.createClient(
            cfg.supabaseUrl,
            cfg.supabasePublishableKey,
            {
              auth: {
                persistSession: false,
                autoRefreshToken: false,
                storageKey: "unauthenticated-test",
              },
            },
          );
          const anonInsert = await anon
            .from("urban_echoes")
            .insert({
              id: crypto.randomUUID(),
              owner_id: row.ownerId,
              title: "Unauthenticated forbidden test",
              story: "Must not be saved.",
              lat: row.lat,
              lng: row.lng,
            });
          const remaining = await c
            .from("urban_echoes")
            .select("id,title")
            .eq("id", row.id)
            .single();
          return {
            forgedError: forged.error?.code,
            deleted: deleted.data,
            updateError: altered.error?.code,
            uploadDenied: !!badUpload.error,
            removed: badRemove.data,
            anonError: anonInsert.error?.code,
            remaining: remaining.data,
          };
        }, record);
        assert.equal(result.forgedError, "42501");
        assert.deepEqual(result.deleted, []);
        assert.equal(result.updateError, "42501");
        assert.equal(result.uploadDenied, true);
        assert.deepEqual(result.removed, []);
        assert.equal(result.anonError, "42501");
        assert.equal(result.remaining.title, title);
        const exists = await a.evaluate(async (row) => {
          const c = supabase.createClient(
            URBAN_ECHO_CONFIG.supabaseUrl,
            URBAN_ECHO_CONFIG.supabasePublishableKey,
          );
          const result = await c.storage
            .from("urban-echo-photos")
            .list(row.ownerId);
          return result.data?.some((file) => file.name === row.id + ".jpg");
        }, record);
        assert.equal(exists, true);
      },
    );
    await check(
      "creator session survives reload and can delete the shared row and photo",
      async () => {
        await a.reload();
        await a.locator(".echo").filter({ hasText: title }).click();
        assert.equal(await a.locator("#delete-echo").isVisible(), true);
        await a.locator("#delete-echo").click();
        await a.locator("#delete-yes").click();
        await a.locator("#detail-dialog").waitFor({ state: "hidden" });
        const exists = await a.evaluate(async (row) => {
          const c = supabase.createClient(
            URBAN_ECHO_CONFIG.supabaseUrl,
            URBAN_ECHO_CONFIG.supabasePublishableKey,
          );
          const result = await c.storage
            .from("urban-echo-photos")
            .list(row.ownerId);
          return result.data?.some((file) => file.name === row.id + ".jpg");
        }, record);
        assert.equal(exists, false);
        await b.locator("#refresh-shared").click();
        await b
          .locator(".echo")
          .filter({ hasText: title })
          .waitFor({ state: "hidden" });
      },
    );
    await check(
      "shared workflow throws no uncaught application errors",
      async () => assert.deepEqual(errors, []),
    );
    console.log(
      "RESULT: " +
        passed +
        " live shared-storage checks passed. Two anonymous browser sessions; real database and storage; simulated GPS and synthetic image. Test Echo and photo deleted. Physical-phone evaluation remains outstanding.",
    );
  } finally {
    if (a)
      await a
        .evaluate(async (title) => {
          for (const row of await EchoCloud.load())
            if (row.title === title && row.ownerId === EchoCloud.userId)
              await EchoCloud.remove(row);
        }, title)
        .catch((e) => console.log("CLEANUP pending: " + e.message));
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
