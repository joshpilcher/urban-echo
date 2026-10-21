/* Controller lifecycle with fake devices/clock; browser tests exercise real encoding. */
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs");
function setup({ pending = false, denied = false, supported = true } = {}) {
  let now = 0,
    interval,
    resolvePermission,
    request;
  const events = [],
    errors = [],
    ready = [],
    tracks = [
      {
        stopped: false,
        stop() {
          this.stopped = true;
        },
        addEventListener() {},
      },
    ];
  const stream = { getTracks: () => tracks };
  class Recorder {
    static isTypeSupported(t) {
      return t.includes("webm");
    }
    constructor(s, o) {
      this.mimeType = o.mimeType;
      this.state = "inactive";
      request = this;
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({
        data: new Blob(["recorded"], { type: this.mimeType }),
      });
      this.onstop?.();
    }
  }
  const window = {
    EchoCore: require("../core.js"),
    MediaRecorder: supported ? Recorder : undefined,
  };
  const navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        if (denied)
          throw Object.assign(new Error(), { name: "NotAllowedError" });
        if (pending) return new Promise((r) => (resolvePermission = r));
        return stream;
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(
      require("node:path").join(__dirname, "../recording.js"),
      "utf8",
    ),
    {
      window,
      navigator,
      MediaRecorder: Recorder,
      Blob,
      performance: { now: () => now },
      setInterval: (f) => ((interval = f), 1),
      clearInterval: () => {},
    },
  );
  const recorder = window.EchoRecorder.create({
    onState: (...x) => events.push(x),
    onReady: (...x) => ready.push(x),
    onError: (e) => errors.push(e.message),
  });
  return {
    recorder,
    tracks,
    events,
    errors,
    ready,
    resolve: () => resolvePermission(stream),
    tick: (seconds) => {
      now = seconds * 1000;
      interval();
    },
    request: () => request,
  };
}
test("stop produces media and releases every device track", async () => {
  const x = setup();
  await x.recorder.start("audio");
  x.tick(2);
  x.recorder.stop();
  assert.equal(x.ready[0][1], "audio");
  assert.equal(x.ready[0][2], 2);
  assert.ok(x.tracks.every((t) => t.stopped));
  assert.equal(x.recorder.busy, false);
});
test("cancel pending permission releases a late stream and never records", async () => {
  const x = setup({ pending: true });
  const p = x.recorder.start("video");
  x.recorder.cancel();
  x.resolve();
  await p;
  assert.ok(x.tracks.every((t) => t.stopped));
  assert.equal(x.ready.length, 0);
  assert.equal(x.request(), undefined);
});
test("permission denial and missing support provide file fallback", async () => {
  for (const options of [{ denied: true }, { supported: false }]) {
    const x = setup(options);
    await x.recorder.start("audio");
    assert.equal(x.errors.length, 1);
    assert.match(x.errors[0], /file/);
    assert.equal(x.recorder.busy, false);
  }
});
test("video and audio automatically stop at their respective time limits", async () => {
  for (const [kind, limit] of [
    ["video", 30],
    ["audio", 60],
  ]) {
    const x = setup();
    await x.recorder.start(kind);
    x.tick(limit);
    assert.equal(x.ready[0][2], limit);
    assert.ok(x.tracks.every((t) => t.stopped));
  }
});
test("oversized and interrupted recordings are discarded with devices released", async () => {
  for (const failure of ["size", "error"]) {
    const x = setup();
    await x.recorder.start("audio");
    if (failure === "size")
      x.request().ondataavailable({
        data: new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]),
      });
    else x.request().onerror();
    assert.equal(x.ready.length, 0);
    assert.equal(x.errors.length, 1);
    assert.ok(x.tracks.every((t) => t.stopped));
  }
});
test("cancel active recording discards chunks and does not replace attachment", async () => {
  const x = setup();
  await x.recorder.start("video");
  x.recorder.cancel();
  assert.equal(x.ready.length, 0);
  assert.equal(x.recorder.busy, false);
  assert.ok(x.tracks.every((t) => t.stopped));
});
