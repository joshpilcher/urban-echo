/* Real MediaRecorder with Chromium's synthetic camera/microphone. GPS is simulated.
 * --shared explicitly uses real Supabase; removes its rows/objects in finally. */
const { chromium } = require("playwright");
const assert = require("node:assert/strict"),
  http = require("node:http");
const fs = require("node:fs/promises"),
  path = require("node:path");
const root = path.resolve(__dirname, ".."),
  shared = process.argv.includes("--shared");
const point = { latitude: -26.6812, longitude: 153.119, accuracy: 8 };
const prefix = "Synthetic recording test " + Date.now();
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
      if (!file.startsWith(root + path.sep)) throw Error();
      if ((await fs.stat(file)).isDirectory())
        file = path.join(file, "index.html");
      res.setHeader(
        "Content-Type",
        { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" }[
          path.extname(file)
        ] || "application/octet-stream",
      );
      res.end(await fs.readFile(file));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + server.address().port + "/";
  let browser, a, b;
  const errors = [];
  try {
    const proxyText = process.env.HTTPS_PROXY || process.env.https_proxy,
      proxy = proxyText ? new URL(proxyText) : null;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
      proxy: proxy
        ? { server: proxy.origin, bypass: "127.0.0.1,localhost" }
        : undefined,
    });
    console.log(
      "Chromium " +
        browser.version() +
        " · synthetic devices/GPS · " +
        (shared ? "real Supabase" : "device-only"),
    );
    async function page() {
      const c = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        reducedMotion: "reduce",
        ignoreHTTPSErrors: true,
        permissions: ["camera", "microphone"],
      });
      if (!shared)
        await c.route("**/config.js", (r) =>
          r.fulfill({
            contentType: "text/javascript",
            body: "window.URBAN_ECHO_CONFIG={};",
          }),
        );
      await c.route("https://**", (r) =>
        shared && new URL(r.request().url()).hostname.endsWith(".supabase.co")
          ? r.continue()
          : r.abort(),
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
        window.__tracks = [];
        const get = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices,
        );
        navigator.mediaDevices.getUserMedia = async (o) => {
          const s = await get(o);
          window.__tracks.push(...s.getTracks());
          return s;
        };
      });
      const p = await c.newPage();
      p.setDefaultTimeout(30000);
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(url);
      await p.locator("#locate").click();
      await p.evaluate((p) => __emit(p), point);
      return p;
    }
    a = await page();
    if (shared) b = await page();
    const emit = async (p, coords = point) =>
      p.evaluate((x) => __emit(x), coords);
    const open = async (p) => {
      await emit(p);
      await p.locator("#nav-map").click();
      await p.locator("#create").click();
    };
    const screenshot = async (p, name) => {
      await fs.mkdir(path.join(root, "test-results/screenshots"), {
        recursive: true,
      });
      await p.evaluate(() => {
        let x = document.getElementById("capture-label");
        if (!x) {
          x = document.createElement("p");
          x.id = "capture-label";
          x.textContent = "SYNTHETIC CAMERA / MICROPHONE · SIMULATED GPS";
          x.style =
            "position:fixed;top:0;left:0;right:0;z-index:9999;margin:0;padding:6px;background:#f5d49a;text-align:center;font:700 10px sans-serif;";
          document.querySelector("#echo-form").prepend(x);
        }
      });
      await p
        .locator(name === "video-recording" ? "#recorder" : "#clip-preview")
        .scrollIntoViewIfNeeded();
      await p.screenshot({
        path: path.join(
          root,
          "test-results/screenshots/iteration-08-" + name + ".png",
        ),
      });
    };
    if (!shared) {
      await check(
        "camera/microphone permission denial preserves text and offers file fallback",
        async () => {
          await open(a);
          await a.locator("#title").fill("Keep my draft");
          await a.evaluate(() => {
            window.__originalGet = navigator.mediaDevices.getUserMedia;
            navigator.mediaDevices.getUserMedia = async () => {
              throw new DOMException("denied", "NotAllowedError");
            };
          });
          await a.locator("#record-audio").click();
          await a.waitForFunction(() =>
            document
              .querySelector("#clip-status")
              .textContent.includes("denied"),
          );
          assert.equal(await a.locator("#title").inputValue(), "Keep my draft");
          await a.evaluate(
            () => (navigator.mediaDevices.getUserMedia = window.__originalGet),
          );
        },
      );
      await check(
        "unsupported recording retains file selection fallback",
        async () => {
          await a.evaluate(() => {
            window.__originalRecorder = window.MediaRecorder;
            window.MediaRecorder = undefined;
          });
          await a.locator("#record-video").click();
          await a.waitForFunction(() =>
            document
              .querySelector("#clip-status")
              .textContent.includes("unavailable"),
          );
          assert.equal(await a.locator("#video-file").isEnabled(), true);
          await a.evaluate(
            () => (window.MediaRecorder = window.__originalRecorder),
          );
        },
      );
      await check(
        "closing active camera recording stops tracks without creating an attachment",
        async () => {
          await a.locator("#record-video").click();
          await a.locator("#recording-live").waitFor({ state: "visible" });
          await a.locator("#close").click();
          await a.waitForFunction(() =>
            __tracks.every((t) => t.readyState === "ended"),
          );
          assert.equal(await a.locator("#clip-preview").isVisible(), false);
        },
      );
      await check(
        "unsupported and oversized files retain draft and show validation",
        async () => {
          await open(a);
          await a.locator("#audio-file").setInputFiles({
            name: "bad.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("bad"),
          });
          await a.waitForFunction(() =>
            document
              .querySelector("#clip-status")
              .textContent.includes("supported"),
          );
          await a.locator("#video-file").setInputFiles({
            name: "large.mp4",
            mimeType: "video/mp4",
            buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
          });
          await a.waitForFunction(() =>
            document
              .querySelector("#clip-status")
              .textContent.includes("20 MB"),
          );
          assert.equal(await a.locator("#title").inputValue(), "Keep my draft");
          await a.locator("#close").click();
        },
      );
    }
    if (!shared)
      await check(
        "file fallback validates duration, previews valid WAV and supports removal on small screens",
        async () => {
          function wav(seconds) {
            const data = Buffer.alloc(44 + 8000 * 2 * seconds);
            data.write("RIFF", 0);
            data.writeUInt32LE(data.length - 8, 4);
            data.write("WAVEfmt ", 8);
            data.writeUInt32LE(16, 16);
            data.writeUInt16LE(1, 20);
            data.writeUInt16LE(1, 22);
            data.writeUInt32LE(8000, 24);
            data.writeUInt32LE(16000, 28);
            data.writeUInt16LE(2, 32);
            data.writeUInt16LE(16, 34);
            data.write("data", 36);
            data.writeUInt32LE(data.length - 44, 40);
            return data;
          }
          await open(a);
          await a.locator("#audio-file").setInputFiles({
            name: "too-long.wav",
            mimeType: "audio/wav",
            buffer: wav(61),
          });
          await a.waitForFunction(() =>
            document
              .querySelector("#clip-status")
              .textContent.includes("60 seconds"),
          );
          await a.locator("#audio-file").setInputFiles({
            name: "short.wav",
            mimeType: "audio/wav",
            buffer: wav(1),
          });
          await a.locator("#clip-preview").waitFor({ state: "visible" });
          assert.equal(await a.locator("#clip-player audio").count(), 1);
          await a.locator("#photo").setInputFiles({
            name: "bad.jpg",
            mimeType: "image/jpeg",
            buffer: Buffer.from("invalid"),
          });
          await a.waitForFunction(() =>
            document
              .querySelector("#photo-status")
              .textContent.includes("could not be opened"),
          );
          assert.equal(await a.locator("#clip-preview").isVisible(), true);

          for (const viewport of [
            { width: 320, height: 568 },
            { width: 390, height: 844 },
            { width: 844, height: 390 },
          ]) {
            await a.setViewportSize(viewport);
            const fits = await a.evaluate(() => {
              const d = document.querySelector("#dialog");
              return d.scrollWidth <= d.clientWidth + 1;
            });
            assert.equal(fits, true);
            await a.locator("#clip-remove").click();
            assert.equal(await a.locator("#clip-preview").isVisible(), false);
            if (viewport.width !== 844) {
              await a.locator("#audio-file").setInputFiles({
                name: "short.wav",
                mimeType: "audio/wav",
                buffer: wav(1),
              });
              await a.locator("#clip-preview").waitFor({ state: "visible" });
            }
          }
          await a.setViewportSize({ width: 390, height: 844 });
          await a.locator("#close").click();
        },
      );
    const galleryTitle = shared
      ? prefix + " mixed gallery"
      : "A moment by the water";
    let galleryRecord;
    const galleryShot = async (name) => {
      await fs.mkdir(path.join(root, "test-results/screenshots"), {
        recursive: true,
      });
      await a.evaluate(() => {
        const x = document.createElement("p");
        x.textContent = "SYNTHETIC MEDIA · SIMULATED GPS";
        x.style =
          "position:fixed;top:0;left:0;right:0;z-index:9999;margin:0;padding:6px;background:#f5d49a;text-align:center;font:700 10px sans-serif;";
        document
          .querySelector(
            document.querySelector("#detail-dialog").open
              ? "#detail-dialog"
              : "#echo-form",
          )
          .prepend(x);
      });
      await a.screenshot({
        path: path.join(
          root,
          "test-results/screenshots/iteration-10-" + name + ".png",
        ),
      });
    };
    await check(
      "one draft combines multiple photos, recorded audio and video, with individual removal",
      async () => {
        await open(a);
        await a.locator("#title").fill(galleryTitle);
        await a
          .locator("#story")
          .fill(
            "A photo, a voice and a moving moment, captured here. Synthetic media for testing the Echo viewing interface.",
          );
        const image = Buffer.from(
          await a.evaluate(() => {
            const c = document.createElement("canvas");
            c.width = 180;
            c.height = 90;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#0b697b";
            ctx.fillRect(0, 0, 180, 90);
            ctx.fillStyle = "#fff";
            ctx.font = "14px sans-serif";
            ctx.fillText("SYNTHETIC PHOTO", 14, 50);
            return c.toDataURL("image/png").split(",")[1];
          }),
          "base64",
        );
        const file = {
          name: "synthetic.png",
          mimeType: "image/png",
          buffer: image,
        };
        await a.locator("#photo").setInputFiles([file, file]);
        await a.waitForFunction(
          () =>
            document.querySelectorAll("#photo-items img").length === 2 &&
            !document.querySelector("#save-echo").disabled,
        );
        for (const kind of ["audio", "video"]) {
          await a.locator("#record-" + kind).click();
          await a.waitForFunction(() =>
            document
              .querySelector("#recording-status")
              .textContent.includes("Recording "),
          );
          await a.waitForTimeout(1300);
          await a.locator("#record-stop").click();
          await a.waitForFunction(
            (kind) =>
              document.querySelectorAll("#clip-player " + kind).length === 1 &&
              !document.querySelector("#save-echo").disabled,
            kind,
          );
        }
        assert.equal(await a.locator(".draft-attachment").count(), 4);
        await a.locator("#photo-remove").click();
        assert.equal(await a.locator("#photo-items img").count(), 1);
        assert.equal(await a.locator("#clip-player audio").count(), 1);
        assert.equal(await a.locator("#clip-player video").count(), 1);
        const kept = await a
          .locator(".draft-attachment")
          .evaluateAll((items) => items.map((x) => x.dataset.attachmentId));
        await a.locator("#photo").setInputFiles(Array(5).fill(file));
        await a.waitForFunction(
          () =>
            document.querySelectorAll(".draft-attachment").length === 8 &&
            !document.querySelector("#save-echo").disabled,
        );
        assert.equal(await a.locator("#record-video").isDisabled(), true);
        assert.equal(await a.locator("#record-audio").isDisabled(), true);
        const extra = await a
          .locator(".draft-attachment")
          .evaluateAll(
            (items, kept) =>
              items
                .map((x) => x.dataset.attachmentId)
                .filter((id) => !kept.includes(id)),
            kept,
          );
        for (const id of extra)
          await a.locator('[data-remove-attachment="' + id + '"]').click();
        assert.equal(await a.locator(".draft-attachment").count(), 3);
        assert.equal(await a.locator("#record-audio").isEnabled(), true);
        await a.locator("#audio-file").setInputFiles({
          name: "invalid.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("invalid"),
        });
        await a.waitForFunction(() =>
          document
            .querySelector("#clip-status")
            .textContent.includes("supported"),
        );
        assert.equal(await a.locator(".draft-attachment").count(), 3);
        for (const viewport of [
          { width: 320, height: 568 },
          { width: 390, height: 844 },
          { width: 844, height: 390 },
        ]) {
          await a.setViewportSize(viewport);
          assert.equal(
            await a
              .locator("#dialog")
              .evaluate((d) => d.scrollWidth <= d.clientWidth + 1),
            true,
          );
        }
        await a.setViewportSize({ width: 390, height: 844 });
        await a.locator("#clip-preview").scrollIntoViewIfNeeded();
        await galleryShot("create");
      },
    );
    await check(
      "failed multi-file save preserves the whole draft and cleans partial storage before retry",
      async () => {
        if (shared) {
          let failurePath;
          await a.route(
            "**/storage/v1/object/urban-echo-recordings/**",
            (route) => {
              if (route.request().method() === "POST" && !failurePath) {
                failurePath = decodeURIComponent(
                  new URL(route.request().url()).pathname.split(
                    "/object/urban-echo-recordings/",
                  )[1],
                );
                return route.fulfill({
                  status: 503,
                  contentType: "application/json",
                  body: JSON.stringify({
                    message: "Synthetic upload interruption",
                    error: "SyntheticFailure",
                    statusCode: 503,
                  }),
                });
              }
              return route.continue();
            },
          );
          await a.locator("#visibility-public").check();
          await emit(a);
          await a.locator("#save-echo").click();
          await a.waitForFunction(() =>
            document
              .querySelector("#form-error")
              .textContent.includes("Attachment"),
          );
          assert.equal(await a.locator(".draft-attachment").count(), 3);
          assert.ok(failurePath);
          const result = await a.evaluate(
            async ({ folder, title }) => {
              const c = supabase.createClient(
                URBAN_ECHO_CONFIG.supabaseUrl,
                URBAN_ECHO_CONFIG.supabasePublishableKey,
              );
              const sizes = [];
              for (const name of [
                "urban-echo-photos",
                "urban-echo-recordings",
              ]) {
                const r = await c.storage.from(name).list(folder);
                if (r.error) throw r.error;
                sizes.push(r.data.length);
              }
              return {
                sizes,
                exists: (await EchoCloud.load()).some((e) => e.title === title),
              };
            },
            {
              folder: failurePath.split("/").slice(0, 2).join("/"),
              title: galleryTitle,
            },
          );
          assert.deepEqual(result.sizes, [0, 0]);
          assert.equal(result.exists, false);
          await a.unroute("**/storage/v1/object/urban-echo-recordings/**");
        } else {
          const ids = await a
            .locator(".draft-attachment")
            .evaluateAll((items) => items.map((x) => x.dataset.attachmentId));
          await a.evaluate(() => {
            window.__setItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
              if (key === "urban-echo-v1")
                throw new DOMException(
                  "Synthetic quota failure",
                  "QuotaExceededError",
                );
              return window.__setItem.call(this, key, value);
            };
          });
          await emit(a);
          await a.locator("#save-echo").click();
          await a.waitForFunction(() =>
            document
              .querySelector("#form-error")
              .textContent.includes("storage"),
          );
          assert.equal(await a.locator(".draft-attachment").count(), 3);
          assert.equal(
            await a.evaluate(
              async (ids) =>
                (await Promise.all(ids.map((id) => EchoMedia.get(id)))).every(
                  (blob) => !blob,
                ),
              ids,
            ),
            true,
          );
          await a.evaluate(
            () => (Storage.prototype.setItem = window.__setItem),
          );
        }
        await emit(a);
        await a.locator("#save-echo").click();
        await a.locator("#dialog").waitFor({ state: "hidden" });
      },
    );
    await check(
      "a mixed Echo persists and reveals all three media types together without playback resets",
      async () => {
        await a.reload();
        await a.locator("#locate").click();
        await emit(a);
        await a.locator("#nav-nearby").click();
        await a.locator(".echo").filter({ hasText: galleryTitle }).click();
        await a.locator("#detail-image img").waitFor();
        await a.locator("#detail-dialog audio").waitFor();
        await a.locator('.media-thumbnail[aria-label^="View video"]').click();
        await a.locator("#detail-image video").waitFor();
        assert.equal(
          await a.locator("#detail-dialog [data-attachment-id]").count(),
          3,
        );
        if (!shared)
          await check(
            "mock-up detail uses one hero, accessible thumbnails and audio below the story",
            async () => {
              await a
                .locator('.media-thumbnail[aria-label^="View photo"]')
                .click();
              assert.equal(await a.locator(".hero-media:visible").count(), 1);
              assert.equal(await a.locator(".media-thumbnail").count(), 2);
              assert.equal(
                await a
                  .locator('.media-thumbnail[aria-pressed="true"]')
                  .getAttribute("aria-label"),
                "View photo 1",
              );
              const order = await a.evaluate(() => {
                const story = document.querySelector("#detail-story"),
                  audio = document.querySelector("#detail-audio"),
                  thumbs = document.querySelector("#detail-gallery");
                return (
                  !!(
                    story.compareDocumentPosition(audio) &
                    Node.DOCUMENT_POSITION_FOLLOWING
                  ) &&
                  !!(
                    audio.compareDocumentPosition(thumbs) &
                    Node.DOCUMENT_POSITION_FOLLOWING
                  )
                );
              });
              assert.equal(order, true);
              for (const viewport of [
                { width: 320, height: 568 },
                { width: 390, height: 844 },
                { width: 844, height: 390 },
              ]) {
                await a.setViewportSize(viewport);
                const fits = await a
                  .locator("#detail-dialog")
                  .evaluate((d) => d.scrollWidth <= d.clientWidth + 1);
                assert.equal(fits, true);
                for (const button of await a
                  .locator(".media-thumbnail")
                  .all()) {
                  const box = await button.boundingBox();
                  assert.ok(box.width >= 44 && box.height >= 44);
                }
              }
              await a.setViewportSize({ width: 390, height: 844 });
              await a
                .locator("#detail-dialog")
                .evaluate((d) => (d.scrollTop = 0));
              await galleryShot("photo-detail");
              await a
                .locator('.media-thumbnail[aria-label^="View video"]')
                .focus();
              await a.keyboard.press("Enter");
              assert.equal(
                await a.locator(".hero-media:visible video").count(),
                1,
              );
              await a.locator("#detail-dialog audio").evaluate((p) => p.play());
              await a.locator("#detail-image video").evaluate((p) => p.play());
              assert.equal(
                await a
                  .locator("#detail-dialog audio")
                  .evaluate((p) => p.paused),
                true,
              );
              await a
                .locator('.media-thumbnail[aria-label^="View photo"]')
                .click();
              assert.equal(
                await a
                  .locator("#detail-image video")
                  .evaluate((p) => p.paused),
                true,
              );
              await a
                .locator('.media-thumbnail[aria-label^="View video"]')
                .click();
              await a.locator("#detail-dialog audio").evaluate((p) => {
                window.__uiAudio = p;
                return p.play();
              });
              await a.locator("#detail-close").click();
              assert.equal(await a.evaluate(() => __uiAudio.paused), true);
              await emit(a);
              await a
                .locator(".echo")
                .filter({ hasText: galleryTitle })
                .click();
              await a
                .locator('.media-thumbnail[aria-label^="View video"]')
                .click();
              await a.locator("#detail-dialog audio").evaluate((p) => {
                window.__uiAudio = p;
                return p.play();
              });
              await a.keyboard.press("Escape");
              assert.equal(await a.evaluate(() => __uiAudio.paused), true);
              await emit(a);
              await a
                .locator(".echo")
                .filter({ hasText: galleryTitle })
                .click();
              await a
                .locator('.media-thumbnail[aria-label^="View video"]')
                .click();
            },
          );
        await a.locator("#detail-dialog audio").evaluate((p) => p.play());
        await a.locator("#detail-image video").evaluate((p) => p.play());
        await a.evaluate(
          () =>
            (window.__galleryPlayers = [
              ...document.querySelectorAll(
                "#detail-dialog audio,#detail-image video",
              ),
            ]),
        );
        await emit(a);
        assert.equal(
          await a.evaluate(() => __galleryPlayers.every((p) => p.isConnected)),
          true,
        );
        await a.locator("#detail-dialog").evaluate((d) => (d.scrollTop = 0));
        await galleryShot("detail");
        await emit(a, { ...point, latitude: point.latitude + 0.003 });
        assert.equal(
          await a
            .locator(
              "#detail-image img,#detail-dialog audio,#detail-image video",
            )
            .count(),
          0,
        );
        assert.equal(
          await a.evaluate(() => __galleryPlayers.every((p) => p.paused)),
          true,
        );
        await emit(a);
        await a.locator('.media-thumbnail[aria-label^="View video"]').click();
        await a.locator("#detail-image video").waitFor();
        galleryRecord = await a.evaluate(
          async ({ title, shared }) =>
            shared
              ? (await EchoCloud.load()).find((e) => e.title === title)
              : JSON.parse(localStorage.getItem("urban-echo-v1")).find(
                  (e) => e.title === title,
                ),
          { title: galleryTitle, shared },
        );
        assert.deepEqual(
          galleryRecord.attachments.map((x) => x.kind),
          ["photo", "audio", "video"],
        );
        await a.locator("#detail-close").click();
      },
    );
    if (shared)
      await check(
        "a second session plays the full gallery but cannot delete its files or forge gallery paths",
        async () => {
          await b.locator("#nav-map").click();
          await b.locator("#refresh-shared").click();
          await emit(b);
          await b.locator("#nav-nearby").click();
          await b.locator(".echo").filter({ hasText: galleryTitle }).click();
          await b.locator("#detail-image img").waitFor();
          await b.locator("#detail-dialog audio").evaluate((p) => p.play());
          await b.locator('.media-thumbnail[aria-label^="View video"]').click();
          await b.locator("#detail-image video").evaluate((p) => p.play());
          assert.equal(await b.locator("#delete-echo").isVisible(), false);
          const result = await b.evaluate(async (row) => {
            const c = supabase.createClient(
              URBAN_ECHO_CONFIG.supabaseUrl,
              URBAN_ECHO_CONFIG.supabasePublishableKey,
            );
            let session = (await c.auth.getSession()).data.session;
            if (!session)
              session = (await c.auth.signInAnonymously()).data.session;
            const removed = [];
            for (const a of row.attachments) {
              const r = await c.storage
                .from(
                  a.kind === "photo"
                    ? "urban-echo-photos"
                    : "urban-echo-recordings",
                )
                .remove([a.path]);
              removed.push(r.data);
            }
            const deletion = await c
              .from("urban_echoes")
              .delete()
              .eq("id", row.id)
              .select();
            const forged = await c.from("urban_echoes").insert({
              id: crypto.randomUUID(),
              owner_id: session.user.id,
              title: "Synthetic invalid gallery",
              story: "Must be rejected",
              lat: 0,
              lng: 0,
              attachments: row.attachments,
            });
            return {
              removed,
              deleted: deletion.data,
              forged: forged.error?.code,
            };
          }, galleryRecord);
          assert.deepEqual(result.removed, [[], [], []]);
          assert.deepEqual(result.deleted, []);
          assert.equal(result.forged, "23514");
          await b.locator("#detail-close").click();
        },
      );
    await check(
      "creator deletion removes every attachment from the mixed Echo",
      async () => {
        await a.locator(".echo").filter({ hasText: galleryTitle }).click();
        await a.locator("#delete-echo").click();
        await a.locator("#delete-yes").click();
        await a.locator("#detail-dialog").waitFor({ state: "hidden" });
        if (shared) {
          const counts = await a.evaluate(async (row) => {
            const c = supabase.createClient(
              URBAN_ECHO_CONFIG.supabaseUrl,
              URBAN_ECHO_CONFIG.supabasePublishableKey,
            );
            const counts = [];
            for (const name of ["urban-echo-photos", "urban-echo-recordings"]) {
              const r = await c.storage
                .from(name)
                .list(row.ownerId + "/" + row.id);
              if (r.error) throw r.error;
              counts.push(r.data.length);
            }
            return counts;
          }, galleryRecord);
          assert.deepEqual(counts, [0, 0]);
        } else
          assert.equal(
            await a.evaluate(
              async (row) =>
                (
                  await Promise.all(
                    row.attachments.map((a) => EchoMedia.get(a.id)),
                  )
                ).every((blob) => !blob),
              galleryRecord,
            ),
            true,
          );
      },
    );
    for (const kind of ["audio", "video"]) {
      const title = prefix + " " + kind;
      await check(
        kind + " records, previews and saves at the current GPS location",
        async () => {
          await open(a);
          await a.locator("#title").fill(title);
          await a
            .locator("#story")
            .fill(
              "Synthetic " +
                kind +
                " fixture, not an outdoor recording. Spoken words would be transcribed here.",
            );
          await a.locator("#record-" + kind).click();
          await a.waitForFunction(() =>
            document
              .querySelector("#recording-status")
              .textContent.includes("Recording "),
          );
          assert.equal(await a.locator("#save-echo").isDisabled(), true);
          await a.waitForTimeout(1600);
          if (kind === "video") await screenshot(a, "video-recording");
          await a.locator("#record-stop").click();
          await a.locator("#clip-preview").waitFor({ state: "visible" });
          assert.equal(await a.locator("#clip-player " + kind).count(), 1);
          assert.equal(await a.locator("#photo-preview").isVisible(), false);
          assert.equal(
            await a.evaluate(() =>
              __tracks.every((t) => t.readyState === "ended"),
            ),
            true,
          );
          if (kind === "audio") await screenshot(a, "audio-preview");
          if (shared) await a.locator("#visibility-public").check();
          await emit(a);
          await a.locator("#save-echo").click();
          await a.locator("#dialog").waitFor({ state: "hidden" });
        },
      );
      await check(
        kind +
          " persists, plays and relocks without resetting playback on GPS updates",
        async () => {
          await a.reload();
          await a.locator("#locate").click();
          await emit(a);
          await a.locator("#nav-nearby").click();
          await a.locator(".echo").filter({ hasText: title }).click();
          const player = a.locator("#detail-dialog " + kind);
          await player.waitFor();
          await player.evaluate((p) => p.play());
          await a.waitForTimeout(350);
          const before = await player.evaluate((p) => p.currentTime);
          assert.ok(before > 0);
          await a.evaluate(
            () =>
              (window.__savedPlayer = document.querySelector(
                "#detail-dialog audio,#detail-image video",
              )),
          );
          await emit(a);
          assert.equal(
            await a.evaluate(
              () =>
                window.__savedPlayer ===
                document.querySelector(
                  "#detail-dialog audio,#detail-image video",
                ),
            ),
            true,
          );
          await emit(a, { ...point, latitude: point.latitude + 0.003 });
          assert.equal(await a.locator("#detail-dialog " + kind).count(), 0);
          assert.equal(
            await a.evaluate(() => window.__savedPlayer.paused),
            true,
          );
          await emit(a);
          await a.locator("#detail-dialog " + kind).waitFor();
          if (kind === "video") {
            await a.evaluate(() => {
              const x = document.createElement("p");
              x.textContent = "SYNTHETIC VIDEO · SIMULATED GPS";
              x.style =
                "margin:0;padding:6px;background:#f5d49a;text-align:center;font:700 10px sans-serif;";
              document.querySelector(".detail-toolbar").after(x);
            });
            await a.screenshot({
              path: path.join(
                root,
                "test-results/screenshots/iteration-08-video-detail.png",
              ),
            });
          }
          await a.locator("#detail-close").click();
        },
      );
      if (shared) {
        await check(
          kind +
            " is discoverable/playable in a second session with owner protections",
          async () => {
            await b.locator("#nav-map").click();
            await b.locator("#refresh-shared").click();
            await b.locator("#nav-nearby").click();
            await emit(b);
            await b.locator("#nav-nearby").click();
            await b.locator(".echo").filter({ hasText: title }).click();
            await b.locator("#detail-dialog " + kind).waitFor();
            await b.locator("#detail-dialog " + kind).evaluate((p) => p.play());
            assert.equal(await b.locator("#delete-echo").isVisible(), false);
            const result = await b.evaluate(async (title) => {
              const row = (await EchoCloud.load()).find(
                (r) => r.title === title,
              );
              const c = supabase.createClient(
                URBAN_ECHO_CONFIG.supabaseUrl,
                URBAN_ECHO_CONFIG.supabasePublishableKey,
              );
              await c.auth.signInAnonymously();
              const deletion = await c
                .from("urban_echoes")
                .delete()
                .eq("id", row.id)
                .select();
              const object = await c.storage
                .from("urban-echo-recordings")
                .remove([EchoCore.attachments(row)[0].path]);
              const upload = await c.storage
                .from("urban-echo-recordings")
                .upload(
                  EchoCore.attachments(row)[0].path + ".webm",
                  new Blob(["x"], { type: "video/webm" }),
                );
              return {
                deleted: deletion.data,
                removed: object.data,
                uploadDenied: !!upload.error,
              };
            }, title);
            assert.deepEqual(result.deleted, []);
            assert.deepEqual(result.removed, []);
            assert.equal(result.uploadDenied, true);
            await b.locator("#detail-close").click();
          },
        );
      }
      await check(
        kind + " creator deletes its record and media blob",
        async () => {
          await a.locator(".echo").filter({ hasText: title }).click();
          const record = await a.evaluate(
            async ({ title, shared }) =>
              shared
                ? (await EchoCloud.load()).find((r) => r.title === title)
                : JSON.parse(localStorage.getItem("urban-echo-v1")).find(
                    (r) => r.title === title,
                  ),
            { title, shared },
          );
          await a.locator("#delete-echo").click();
          await a.locator("#delete-yes").click();
          await a.locator("#detail-dialog").waitFor({ state: "hidden" });
          if (shared) {
            assert.equal(
              await a.evaluate(async (r) => {
                const c = supabase.createClient(
                  URBAN_ECHO_CONFIG.supabaseUrl,
                  URBAN_ECHO_CONFIG.supabasePublishableKey,
                );
                const o = await c.storage
                  .from("urban-echo-recordings")
                  .list(r.ownerId + "/" + r.id);
                return o.data.some(
                  (f) =>
                    f.name === EchoCore.attachments(r)[0].path.split("/").pop(),
                );
              }, record),
              false,
            );
            await b.locator("#nav-map").click();
            await b.locator("#refresh-shared").click();
            await b.locator("#nav-nearby").click();
            await b
              .locator(".echo")
              .filter({ hasText: title })
              .waitFor({ state: "hidden" });
          } else
            assert.equal(
              await a.evaluate(
                (id) => EchoMedia.get(id),
                record.attachments[0].id,
              ),
              undefined,
            );
        },
      );
    }
    await check("no uncaught application errors", async () =>
      assert.deepEqual(errors, []),
    );
    console.log(
      "RESULT: " +
        passed +
        " " +
        (shared ? "real shared-media" : "local media") +
        " browser checks passed. Synthetic devices and GPS; physical phone Safari/Chrome still require testing.",
    );
  } finally {
    if (shared && a)
      await a
        .evaluate(async (prefix) => {
          for (const r of await EchoCloud.load())
            if (r.title.startsWith(prefix) && r.ownerId === EchoCloud.userId)
              await EchoCloud.remove(r);
        }, prefix)
        .catch((e) => console.log("CLEANUP pending: " + e.message));
    if (browser) await browser.close();
    await new Promise((r) => server.close(r));
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
