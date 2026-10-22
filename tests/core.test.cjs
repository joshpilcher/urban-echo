const { test } = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");
const now = 1700000000000;
const origin = { lat: -26.65, lng: 153.07 };
const fix = { ...origin, accuracy: 8, timestamp: now };
const north = (metres) => ({
  lat: origin.lat + ((metres / 6371000) * 180) / Math.PI,
  lng: origin.lng,
});

test("distance is in metres and handles identical and antipodal coordinates", () => {
  assert.equal(Core.metres(origin, origin), 0);
  assert.ok(Math.abs(Core.metres(origin, north(100)) - 100) < 0.001);
  assert.ok(
    Number.isFinite(Core.metres({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })),
  );
});
test("discovery unlocks nearby content and relocks outside 100 metres", () => {
  assert.equal(Core.discovery(north(40), fix, now).state, "unlocked");
  assert.equal(Core.discovery(north(101), fix, now).state, "locked");
  assert.equal(Core.discovery(north(95), fix, now).state, "uncertain");
  assert.equal(Core.discovery(origin, null, now).state, "unavailable");
});
test("accuracy boundary and poor fixes do not reveal uncertain content", () => {
  assert.equal(
    Core.discovery(origin, { ...fix, accuracy: 100 }, now).state,
    "unlocked",
  );
  assert.equal(
    Core.discovery(origin, { ...fix, accuracy: 101 }, now).state,
    "uncertain",
  );
  assert.equal(Core.canCreate({ ...fix, accuracy: 100 }, now), true);
  assert.equal(Core.canCreate({ ...fix, accuracy: 101 }, now), false);
});
test("old, future, invalid and missing fixes cannot reveal or save memories", () => {
  for (const candidate of [
    null,
    { ...fix, timestamp: now - 30000 },
    { ...fix, timestamp: now + 1 },
    { ...fix, accuracy: -1 },
    { ...fix, accuracy: NaN },
    { ...fix, lat: 91 },
    { ...fix, lng: 181 },
  ]) {
    assert.equal(Core.canCreate(candidate, now), false);
    assert.equal(Core.discovery(origin, candidate, now).state, "unavailable");
  }
  assert.equal(Core.canCreate({ ...fix, timestamp: now - 29999 }, now), true);
});
test("stored v0.1 records remain valid; malformed records are rejected", () => {
  const echo = {
    ...origin,
    id: "old-id",
    title: "The first visit",
    story: "A memory.",
    createdAt: "2026-10-19T04:00:00Z",
  };
  assert.equal(Core.validEcho(echo), true);
  for (const record of [
    null,
    {},
    { ...echo, lat: 200 },
    { ...echo, id: "" },
    { ...echo, title: " " },
    { ...echo, story: "x".repeat(1201) },
    { ...echo, createdAt: "invalid" },
  ])
    assert.equal(Core.validEcho(record), false);
});

test("media formats select bounded video/audio types and reject unsupported input", () => {
  const { mediaInfo } = require("../core.js");
  assert.equal(mediaInfo("video/webm;codecs=vp8,opus").maxSeconds, 30);
  assert.equal(mediaInfo("audio/mp4").maxSeconds, 60);
  assert.equal(mediaInfo("audio/mpeg").extension, "mp3");
  assert.equal(mediaInfo("text/html"), null);
});

test("recorded Echo metadata preserves old records and rejects ambiguous attachments", () => {
  const core = require("../core.js");
  const original = {
    id: "test",
    title: "Memory",
    story: "Story",
    lat: 0,
    lng: 0,
    createdAt: new Date().toISOString(),
  };
  assert.equal(
    core.validEcho({ ...original, mediaKind: "audio", mediaId: "test" }),
    true,
  );
  assert.equal(
    core.validEcho({
      ...original,
      mediaKind: "video",
      mediaPath: "owner/test.mp4",
    }),
    true,
  );
  for (const attachment of [
    { mediaKind: "audio" },
    { mediaKind: "other", mediaId: "test" },
    { mediaId: "test" },
    { mediaKind: "video", mediaId: "test", photoId: "test" },
  ])
    assert.equal(core.validEcho({ ...original, ...attachment }), false);
});

test("mixed galleries and legacy attachments normalise without losing types or order", () => {
  const core = require("../core.js"),
    e = {
      id: "test",
      title: "Memory",
      story: "Story",
      lat: 0,
      lng: 0,
      createdAt: new Date().toISOString(),
    };
  const items = [
    { id: "one", kind: "photo" },
    { id: "two", kind: "audio" },
    { id: "three", kind: "video" },
  ];
  assert.equal(core.validEcho({ ...e, attachments: items }), true);
  assert.deepEqual(core.attachments({ ...e, attachments: items }), items);
  assert.deepEqual(core.attachments({ ...e, photoId: "old" }), [
    { id: "old", kind: "photo", path: null },
  ]);
  assert.deepEqual(
    core.attachments({ ...e, mediaId: "old", mediaKind: "audio" }),
    [{ id: "old", kind: "audio", path: null }],
  );
  for (const attachments of [
    [items[0], items[0]],
    Array(9).fill(items[0]),
    [{ id: "bad", kind: "html" }],
  ])
    assert.equal(core.validEcho({ ...e, attachments }), false);
  assert.equal(
    core.validEcho({ ...e, attachments: items, photoId: "legacy" }),
    false,
  );
});

test("file imports accept missing types and picker aliases without accepting wrong media", () => {
  assert.equal(Core.importMediaInfo("", "IMG_1234.MOV", "video").type, "video/quicktime");
  assert.equal(Core.importMediaInfo("application/octet-stream", "clip.mp4", "video").type, "video/mp4");
  assert.equal(Core.importMediaInfo("video/x-m4v", "clip.m4v", "video").type, "video/mp4");
  assert.equal(Core.importMediaInfo("", "clip.webm", "video").type, "video/webm");
  assert.equal(Core.importMediaInfo("", "voice.m4a", "audio").type, "audio/mp4");
  assert.equal(Core.importMediaInfo("text/html", "clip.mp4", "video"), null);
  assert.equal(Core.importMediaInfo("audio/mp4", "voice.mp4", "video"), null);
  assert.equal(Core.importMediaInfo("", "unknown.bin", "video"), null);
});

test("marker emphasis increases on approach while content keeps its unlock boundary", () => {
  const readings = [600,400,250,120,50].map(m=>Core.discovery(origin,{...fix,...north(m)},now));
  assert.equal(readings[0].proximity,0);
  for(let i=1;i<readings.length;i++) assert.ok(readings[i].proximity>readings[i-1].proximity);
  assert.equal(readings.at(-1).proximity,1);
  assert.ok(readings.slice(0,-1).every(r=>r.state==='locked'));
  assert.equal(readings.at(-1).state,'unlocked');
});
test("uncertainty and stale GPS do not show full marker confidence", () => {
  const uncertain=Core.discovery(origin,{...fix,...north(95),accuracy:15},now);
  assert.equal(uncertain.state,'uncertain');assert.ok(uncertain.proximity<1);
  assert.ok(Core.discovery(origin,{...fix,accuracy:300},now).proximity<Core.discovery(origin,fix,now).proximity);
  assert.equal(Core.discovery(origin,null,now).proximity,0);
  assert.equal(Core.discovery(origin,{...fix,timestamp:now-30000},now).proximity,0);
});
