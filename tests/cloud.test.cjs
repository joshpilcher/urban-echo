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
  let uploads = 0,
    inserted;
  const bucket = {
    upload: async (...args) => {
      calls.push(["upload", ...args]);
      uploads++;
      return {
        error:
          options.failUploadAt === uploads
            ? { statusCode: 503 }
            : options.uploadError || null,
      };
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
          inserted = value;
          return q;
        },
        delete: () => {
          operation = "delete";
          return q;
        },
        eq: () => q,
        single: async () => ({
          data: options.insertError
            ? null
            : options.collection
              ? { ...row, photo_path: null, ...inserted }
              : row,
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

const mixed = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    kind: "photo",
    blob: { type: "image/jpeg", size: 512 },
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    kind: "audio",
    blob: { type: "audio/mp4", size: 1024 },
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    kind: "video",
    blob: { type: "video/webm", size: 2048 },
  },
];
test("a mixed gallery commits one row with ordered unique owner/Echo/file paths", async () => {
  const { cloud, calls } = setup({ collection: true });
  const saved = await cloud.createCollection(echo, mixed);
  assert.deepEqual(
    Array.from(saved.attachments, (a) => a.kind),
    ["photo", "audio", "video"],
  );
  const uploads = calls.filter((c) => c[0] === "upload");
  assert.equal(uploads.length, 3);
  assert.equal(uploads[0][1], "owner/echo-id/" + mixed[0].id + ".jpg");
  assert.equal(uploads[2][1], "owner/echo-id/" + mixed[2].id + ".webm");
  assert.equal(calls.filter((c) => c[0] === "insert").length, 1);
});
test("partial gallery upload failure cleans attempted files and never inserts a partial Echo", async () => {
  const { cloud, calls } = setup({ collection: true, failUploadAt: 2 });
  await assert.rejects(
    () => cloud.createCollection(echo, mixed),
    /Attachment 2/,
  );
  assert.equal(calls.filter((c) => c[0] === "insert").length, 0);
  assert.equal(calls.filter((c) => c[0] === "upload").length, 2);
  assert.equal(
    calls.filter((c) => c[0] === "remove").flatMap((c) => c[1]).length,
    2,
  );
});
test("gallery upload uncertainty preserves files for retry, and a committed row reconciles safely", async () => {
  for (const committed of [false, true]) {
    const existing = committed
      ? {
          ...row,
          photo_path: null,
          attachments: mixed.map((a) => ({
            id: a.id,
            kind: a.kind,
            path: "owner/echo-id/" + a.id + ".webm",
          })),
        }
      : null;
    const { cloud, calls } = setup({
      collection: true,
      insertError: { message: "lost" },
      existing,
      lookupError: committed ? null : { message: "offline" },
    });
    if (committed)
      assert.equal(
        (await cloud.createCollection(echo, mixed)).attachments.length,
        3,
      );
    else
      await assert.rejects(() => cloud.createCollection(echo, mixed), /draft/);
    assert.equal(
      calls.some((c) => c[0] === "remove"),
      false,
    );
  }
});
test("gallery count and combined size limits reject before network writes", async () => {
  for (const attachments of [
    Array(9).fill(mixed[0]),
    Array.from({ length: 3 }, (_, i) => ({
      ...mixed[2],
      id: mixed[i].id,
      blob: { type: "video/webm", size: 18 * 1024 * 1024 },
    })),
  ]) {
    const { cloud, calls } = setup({ collection: true });
    await assert.rejects(
      () => cloud.createCollection(echo, attachments),
      /50 MB/,
    );
    assert.equal(calls.length, 0);
  }
});
test("gallery deletion removes every photo and recording before its row", async () => {
  const { cloud, calls } = setup();
  await cloud.remove({
    ownerId: "owner",
    attachments: mixed.map((a) => ({
      id: a.id,
      kind: a.kind,
      path: "owner/echo-id/" + a.id + ".webm",
    })),
  });
  assert.equal(
    calls.filter((c) => c[0] === "remove").flatMap((c) => c[1]).length,
    3,
  );
  assert.equal(calls.at(-1)[0], "delete");
});
