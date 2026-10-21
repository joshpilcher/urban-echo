/* Explicit live integration test. Uses synthetic GPS/image/content, two isolated
 * anonymous sessions, and the configured real Supabase service. Deletes its Echo. */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const point = { latitude: -26.6812, longitude: 153.119, accuracy: 8 };
const title = "Synthetic interaction test " + Date.now();
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
    for (let i = 0; i < 3; i++) {
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
    const c = await contexts[2].newPage();
    await c.goto(url);
    for(const p of [a,b,c]) await p.waitForFunction(()=>!document.querySelector("#community-status").textContent.includes("Finding"));
    await a.evaluate(()=>{const n=document.createElement("div");n.textContent="SYNTHETIC INTERACTIONS · SIMULATED GPS";n.style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#f6d59d;text-align:center;font:700 11px sans-serif;padding:5px";document.body.append(n);});
    record = await a.evaluate(async title=>EchoCloud.createCollection({id:crypto.randomUUID(),title,story:"Synthetic interaction fixture, not a real visitor memory.",lat:-26.6812,lng:153.119},[]),title);
    await check("public Echo is available in a separate session",async()=>{
      await b.locator("#refresh-shared").click();await b.locator("#locate").click();await b.evaluate(p=>__emit(p),point);
      await b.locator("#nav-nearby").click();await b.locator(".echo").filter({hasText:title}).click();
      await b.waitForFunction(()=>!document.querySelector("#echo-like").disabled);
    });
    await check("one like persists across reload and duplicate requests",async()=>{
      await b.locator("#echo-like").click();await b.waitForFunction(()=>document.querySelector("#echo-like").textContent.includes("Liked · 1"));
      await b.evaluate(async id=>{await EchoCloud.like(id,true);await EchoCloud.like(id,true);},record.id);
      assert.equal((await b.evaluate(id=>EchoCloud.interactions(id),record.id)).count,1);
      await b.reload();await b.locator("#locate").click();await b.evaluate(p=>__emit(p),point);await b.locator("#nav-nearby").click();await b.locator(".echo").filter({hasText:title}).click();
      await b.waitForFunction(()=>document.querySelector("#echo-like").getAttribute("aria-pressed")==="true");
    });
    await check("failed reply preserves draft and retry posts literal text",async()=>{
      await b.locator("#reply-body").fill("A lovely place. <img src=x onerror=alert(1)>");
      await b.route("**/rest/v1/urban_echo_replies*",r=>r.request().method()==="POST"?r.fulfill({status:503,contentType:"application/json",body:'{"message":"synthetic outage"}'}):r.continue());
      await b.locator("#reply-submit").click();await b.locator("#social-error").filter({hasText:"draft is still here"}).waitFor();
      assert.ok((await b.locator("#reply-body").inputValue()).includes("lovely"));await b.unroute("**/rest/v1/urban_echo_replies*");
      await b.locator("#reply-submit").click();await b.locator(".reply-card").waitFor();
      assert.equal(await b.locator(".reply-card img").count(),0);assert.equal(await b.locator("#reply-body").inputValue(),"");
    });
    await check("Activity shows only interactions on the owner's Echoes",async()=>{
      await a.locator("#nav-activity").click();await a.locator(".activity-card").filter({hasText:"replied"}).waitFor();
      assert.equal(await a.locator(".activity-card").count(),2);
      await b.locator("#detail-close").click();await b.locator("#nav-activity").click();await b.waitForFunction(()=>!document.querySelector("#activity-status").textContent.includes("Loading"));
      assert.equal(await b.locator(".activity-card").filter({hasText:title}).count(),0);
      await a.screenshot({path:path.join(root,"test-results/screenshots/iteration-12-activity.png")});
    });
    await check("Activity opens a locked Echo without exposing reply controls",async()=>{
      await a.locator(".activity-echo").first().click();assert.equal(await a.locator("#echo-social").isVisible(),false);
      await a.locator("#detail-close").click();await a.locator("#nav-map").click();await a.locator("#refresh-shared").click();await a.locator("#locate").click();await a.evaluate(p=>__emit(p),point);
      await a.locator("#nav-mine").click();await a.locator(".echo").filter({hasText:title}).click();await a.locator(".reply-card").waitFor();
      assert.equal(await a.locator("#echo-like").isDisabled(),true);assert.equal(await a.locator(".reply-delete").count(),0);
      await a.screenshot({path:path.join(root,"test-results/screenshots/iteration-12-replies.png")});
    });
    await check("third session cannot forge author or delete another visitor's interactions",async()=>{
      const author=await b.evaluate(()=>EchoCloud.userId);
      const result=await c.evaluate(async ({record,author})=>{
        const sdk=supabase.createClient(URBAN_ECHO_CONFIG.supabaseUrl,URBAN_ECHO_CONFIG.supabasePublishableKey);
        await sdk.auth.signInAnonymously();
        const fake=await sdk.from("urban_echo_replies").insert({id:crypto.randomUUID(),echo_id:record.id,user_id:author,body:"forged"});
        const del=await sdk.from("urban_echo_replies").delete().eq("echo_id",record.id).select();
        const likes=await sdk.from("urban_echo_likes").delete().eq("echo_id",record.id).select();
        const invalid=await sdk.from("urban_echo_replies").insert({id:crypto.randomUUID(),echo_id:record.id,user_id:(await sdk.auth.getSession()).data.session.user.id,body:" ".repeat(3)});
        return {fake:fake.error?.code,deleted:del.data,likes:likes.data,invalid:invalid.error?.code};
      },{record,author});
      assert.equal(result.fake,"42501");assert.deepEqual(result.deleted,[]);assert.deepEqual(result.likes,[]);assert.equal(result.invalid,"23514");
    });
    await check("GPS relocking clears replies and preserves an unfinished draft",async()=>{
      await b.locator("#nav-map").click();await b.locator("#nav-nearby").click();await b.locator(".echo").filter({hasText:title}).click();await b.locator(".reply-card").waitFor();
      await b.locator("#reply-body").fill("Unfinished reply");await b.evaluate(p=>__emit({...p,latitude:p.latitude+.01}),point);
      await b.locator("#echo-social").waitFor({state:"hidden"});assert.equal(await b.locator(".reply-card").count(),0);
      await b.evaluate(p=>__emit(p),point);await b.locator(".reply-card").waitFor();assert.equal(await b.locator("#reply-body").inputValue(),"Unfinished reply");
    });
    await check("unlike and reply deletion update owner Activity",async()=>{
      await b.locator("#echo-like").click();await b.waitForFunction(()=>document.querySelector("#echo-like").textContent.includes("Like · 0"));
      await b.locator(".reply-delete").click();await b.locator(".reply-card").waitFor({state:"hidden"});
      await a.locator("#detail-close").click();await a.locator("#nav-activity").click();await a.waitForFunction(()=>!document.querySelector("#activity-status").textContent.includes("Loading"));assert.equal(await a.locator(".activity-card").count(),0);
    });
    await check("mobile Activity fits narrow and landscape screens",async()=>{
      for(const size of [{width:320,height:568},{width:844,height:390}]) {
        await a.setViewportSize(size);assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        const nav=await a.locator("#nav-activity").boundingBox();assert.ok(nav.height>=44);
      }
    });
    await check("Echo deletion cascades likes and replies",async()=>{
      await b.evaluate(async id=>{await EchoCloud.like(id,true);await EchoCloud.reply(id,crypto.randomUUID(),"Cascade fixture");},record.id);
      await a.evaluate(row=>EchoCloud.remove(row),record);
      const data=await b.evaluate(id=>EchoCloud.interactions(id),record.id);assert.equal(data.count,0);assert.deepEqual(data.replies,[]);
    });
    assert.deepEqual(errors,[]);
    console.log("RESULT: "+passed+" live interaction checks passed; synthetic GPS and content. Test Echo/interactions removed.");
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
