/* Adapter contract checks use a fake SDK; they do not validate live Supabase RLS. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync(
  require("node:path").join(__dirname, "../cloud.js"),
  "utf8",
);
const echo = {
  id: "echo-id",
  title: "A memory",
  story: "A story",
  lat: -26.68,
  lng: 153.11,
  createdAt: "2026-10-19T04:00:00Z",
};
const row = {
  id: echo.id,
  title: echo.title,
  story: echo.story,
  lat: echo.lat,
  lng: echo.lng,
  created_at: echo.createdAt,
  owner_id: "owner",
  photo_path: "owner/echo-id.jpg",
};
function setup(options = {}) {
  const calls = [];
  const bucket = {
    upload: async (...args) => {
      calls.push(["upload", ...args]);
      return { error: options.uploadError || null };
    },
    remove: async (...args) => {
      calls.push(["remove", ...args]);
      return { error: options.removeError || null };
    },
    getPublicUrl: (path) => ({
      data: { publicUrl: "https://example.supabase.co/photo/" + path },
    }),
  };
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: options.noSession ? null : { user: { id: "owner" } } },
      }),
      signInAnonymously: async () => {
        calls.push(["signIn"]);
        return {
          data: { session: { user: { id: "owner" } } },
          error: options.authError,
        };
      },
    },
    storage: { from: () => bucket },
    from: () => {
      let operation = "select";
      const q = {
        select: () => q,
        order: () => q,
        limit: async () => ({ data: [row], error: options.loadError }),
        insert: (value) => {
          operation = "insert";
          calls.push(["insert", value]);
          return q;
        },
        delete: () => {
          operation = "delete";
          return q;
        },
        eq: () => q,
        single: async () => ({
          data: options.insertError ? null : row,
          error: options.insertError,
        }),
        maybeSingle: async () => ({
          data: options.existing || null,
          error: options.lookupError,
        }),
        then: (resolve) => {
          calls.push([operation]);
          return Promise.resolve({ error: options.deleteError }).then(resolve);
        },
      };
      return q;
    },
  };
  const window = {
    URBAN_ECHO_CONFIG: {
      supabaseUrl: "https://example.supabase.co",
      supabasePublishableKey:
        options.key === undefined ? "sb_publishable_test" : options.key,
    },
    EchoCore: require("../core.js"),
    supabase: { createClient: () => client },
  };
  vm.runInNewContext(source, { window, URL, atob });
  return { cloud: window.EchoCloud, calls };
}
test("missing public config and secret keys disable sharing", () => {
  for (const key of [
    "",
    "sb_secret_do-not-use",
    "a." +
      Buffer.from(JSON.stringify({ role: "service_role" })).toString(
        "base64url",
      ) +
      ".b",
  ])
    assert.equal(setup({ key }).cloud.available, false);
});
test("public read normalises server fields without creating an anonymous account", async () => {
  const { cloud, calls } = setup({ noSession: true });
  const records = await cloud.load();
  assert.equal(records[0].source, "shared");
  assert.equal(records[0].ownerId, "owner");
  assert.equal(calls.length, 0);
});
test("public photo creation authenticates only on contribution and uses an owner-scoped path", async () => {
  const { cloud, calls } = setup({ noSession: true });
  const photo = { type: "image/jpeg" };
  const saved = await cloud.create(echo, photo);
  assert.equal(calls[0][0], "signIn");
  assert.equal(calls[1][1], "owner/echo-id.jpg");
  assert.equal(calls[2][1].owner_id, "owner");
  assert.equal(saved.id, echo.id);
});
test("upload failure does not insert the story", async () => {
  const { cloud, calls } = setup({ uploadError: { statusCode: 500 } });
  await assert.rejects(() => cloud.create(echo, {}), /photo could not upload/);
  assert.ok(!calls.some((c) => c[0] === "insert"));
});
test("uncertain insert reconciles committed row and retains its photo", async () => {
  const { cloud, calls } = setup({
    insertError: { message: "network response lost" },
    existing: row,
  });
  assert.equal((await cloud.create(echo, {})).id, echo.id);
  assert.ok(!calls.some((c) => c[0] === "remove"));
});
test("definite failed insert cleans photo while unknown outcome preserves it for retry", async () => {
  for (const lookupError of [null, { message: "offline" }]) {
    const { cloud, calls } = setup({
      insertError: { code: "failure" },
      lookupError,
    });
    await assert.rejects(() => cloud.create(echo, {}), /draft is still here/);
    assert.equal(
      calls.some((c) => c[0] === "remove"),
      !lookupError,
    );
  }
});
test("adapter rejects deleting another creator’s contribution", async () => {
  const { cloud, calls } = setup();
  await assert.rejects(
    () => cloud.remove({ ownerId: "other" }),
    /Only the creator/,
  );
  assert.equal(calls.length, 0);
});
test("photo deletion failure leaves the Echo row untouched", async () => {
  const { cloud, calls } = setup({ removeError: { message: "offline" } });
  await assert.rejects(
    () => cloud.remove({ ownerId: "owner", photoPath: row.photo_path }),
    /has not been deleted/,
  );
  assert.ok(!calls.some((c) => c[0] === "delete"));
});

test("recording creation uses a separate owner-scoped media path and MIME", async () => {
  const { cloud, calls } = setup();
  await cloud.create(
    { ...echo, mediaKind: "video" },
    { type: "video/webm", size: 1024 },
  );
  const upload = calls.find((c) => c[0] === "upload");
  assert.equal(upload[1], "owner/echo-id.webm");
  assert.equal(upload[3].contentType, "video/webm");
  const insert = calls.find((c) => c[0] === "insert")[1];
  assert.equal(insert.media_kind, "video");
  assert.equal(insert.media_path, "owner/echo-id.webm");
  assert.equal(insert.photo_path, null);
});
test("recording type mismatch is rejected before storage or row insertion", async () => {
  const { cloud, calls } = setup();
  await assert.rejects(
    () =>
      cloud.create(
        { ...echo, mediaKind: "video" },
        { type: "audio/mp4", size: 1024 },
      ),
    /unsupported/,
  );
  assert.equal(calls.length, 0);
});
