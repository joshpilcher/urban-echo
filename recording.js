/* Device preview and recording are separate explicit steps. Tracks stop on every exit. */
(() => {
  "use strict";
  window.EchoRecorder = {
    get supported() {
      return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    },
    create({ onState, onReady, onError }) {
      let state = "idle",
        token = 0,
        session = null;
      function setState(next, data = {}) {
        state = next;
        onState(next, data);
      }
      function release(s) {
        clearInterval(s.timer);
        s.stream.getTracks().forEach((t) => t.stop());
      }
      function cancel() {
        token++;
        const s = session;
        session = null;
        if (s) {
          s.cancelled = true;
          if (s.recorder.state !== "inactive") s.recorder.stop();
          release(s);
        }
        setState("idle");
      }
      function stop() {
        const s = session;
        if (!s || s.recorder.state !== "recording") return;
        s.duration = Math.min((performance.now() - s.started) / 1000, s.limit);
        setState("processing");
        s.recorder.stop();
        release(s);
      }
      async function prepare(kind) {
        if (state !== "idle") return;
        if (!window.EchoRecorder.supported) {
          onError(
            new Error(
              "Recording is unavailable here. Choose a video or audio file instead.",
            ),
          );
          return;
        }
        const id = ++token;
        setState("requesting", { kind });
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video:
              kind === "video"
                ? {
                    facingMode: "environment",
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                  }
                : false,
          });
          if (id !== token) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          const types =
            kind === "video"
              ? ["video/mp4", "video/webm;codecs=vp8,opus", "video/webm"]
              : [
                  "audio/mp4",
                  "audio/webm;codecs=opus",
                  "audio/webm",
                  "audio/ogg;codecs=opus",
                ];
          const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
          if (!mimeType)
            throw new Error(
              "No supported recording format. Choose a file instead.",
            );
          const recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 1800000,
            audioBitsPerSecond: 96000,
          });
          const info = window.EchoCore.mediaInfo(mimeType);
          const s = {
            recorder,
            stream,
            kind,
            limit: info.maxSeconds,
            started: performance.now(),
            chunks: [],
            bytes: 0,
            cancelled: false,
          };
          session = s;
          recorder.ondataavailable = (event) => {
            if (s.cancelled || !event.data.size) return;
            s.chunks.push(event.data);
            s.bytes += event.data.size;
            if (s.bytes > info.maxBytes) {
              cancel();
              onError(
                new Error(
                  "Recording reached the file size limit. Please make a shorter clip.",
                ),
              );
            }
          };
          recorder.onerror = () => {
            cancel();
            onError(new Error("Recording was interrupted. Please try again."));
          };
          recorder.onstop = () => {
            release(s);
            if (s.cancelled || id !== token) return;
            session = null;
            setState("idle");
            const blob = new Blob(s.chunks, {
              type: recorder.mimeType || mimeType,
            });
            if (!blob.size)
              onError(
                new Error("No recording was captured. Please try again."),
              );
            else
              onReady(
                blob,
                kind,
                s.duration ||
                  Math.min((performance.now() - s.started) / 1000, s.limit),
              );
          };
          stream
            .getTracks()
            .forEach((t) => t.addEventListener("ended", () => {
              if (session !== s || s.cancelled) return;
              if (state === "ready") { cancel(); onError(new Error("Device preview ended. Open the recorder again.")); }
              else stop();
            }, { once: true }));
          s.begin = () => {
          s.started = performance.now();
          recorder.start(250);
          s.timer = setInterval(() => {
            const seconds = Math.floor((performance.now() - s.started) / 1000);
            if (seconds >= s.limit) stop();
            else if (seconds !== s.lastSeconds) {
              s.lastSeconds = seconds;
              setState("recording", { kind, stream, seconds, limit: s.limit });
            }
          }, 250);
          setState("recording", { kind, stream, seconds: 0, limit: s.limit });
          };
          setState("ready", { kind, stream, seconds: 0, limit: s.limit });
        } catch (error) {
          stream?.getTracks().forEach((t) => t.stop());
          if (id !== token) return;
          session = null;
          setState("idle");
          onError(
            new Error(
              error.name === "NotAllowedError"
                ? "Camera or microphone permission was denied. Allow access in browser settings, or choose a file."
                : error.name === "NotFoundError"
                  ? "No camera or microphone was found. Choose a file instead."
                  : error.message ||
                    "Recording could not start. Choose a file instead.",
            ),
          );
        }
      }
      function start() {
        if (state !== "ready" || !session) return;
        try { session.begin(); }
        catch { cancel(); onError(new Error("Recording could not start. Open the recorder and try again.")); }
      }
      return {
        prepare,
        start,
        stop,
        cancel,
        get busy() {
          return state !== "idle";
        },
      };
    },
  };
})();
