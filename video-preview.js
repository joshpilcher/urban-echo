/* Extract a real still frame without playing the visible clip or changing its position. */
(() => {
  "use strict";
  const fallback = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" rx="18" fill="#e9f1f3"/><circle cx="320" cy="160" r="40" fill="#0b7580"/><path d="m311 140 28 20-28 20Z" fill="white"/><text x="320" y="240" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#385b67">Tap Play to watch</text></svg>'
  );
  window.EchoVideo = {
    preview(player) {
      let disposed = false, finished = false, posterURL = null;
      const probe = document.createElement("video");
      probe.crossOrigin = "anonymous";
      probe.preload = "auto";
      probe.muted = true;
      probe.playsInline = true;
      player.poster = fallback;
      player.dataset.preview = "loading";
      const cleanup = () => {
        clearTimeout(timer);
        probe.onloadedmetadata = probe.onloadeddata = probe.onseeked = probe.onerror = null;
        probe.removeAttribute("src");
        probe.load();
      };
      const fail = () => {
        if (disposed || finished) return;
        finished = true;
        player.dataset.preview = "unavailable";
        cleanup();
      };
      const capture = () => {
        if (disposed || finished || probe.seeking || probe.readyState < 2 || !probe.videoWidth) return;
        finished = true;
        try {
          const scale = Math.min(1, 640 / Math.max(probe.videoWidth, probe.videoHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(probe.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(probe.videoHeight * scale));
          canvas.getContext("2d").drawImage(probe, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(blob => {
            if (disposed) return;
            if (blob) {
              posterURL = URL.createObjectURL(blob);
              player.poster = posterURL;
              player.dataset.preview = "ready";
            } else player.dataset.preview = "unavailable";
          }, "image/jpeg", 0.8);
        } catch {
          player.dataset.preview = "unavailable";
        } finally { cleanup(); }
      };
      const timer = setTimeout(fail, 15000);
      probe.onloadedmetadata = () => {
        try {
          probe.currentTime = Number.isFinite(probe.duration)
            ? Math.min(0.1, probe.duration / 2) : 0.1;
        } catch { /* A decoded first frame is also a useful preview. */ }
      };
      probe.onloadeddata = probe.onseeked = capture;
      probe.onerror = fail;
      player.disposePreview = () => {
        disposed = true;
        cleanup();
        if (posterURL) URL.revokeObjectURL(posterURL);
      };
      probe.src = player.src;
    },
  };
})();
