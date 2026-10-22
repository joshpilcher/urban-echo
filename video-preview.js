/* A real JPEG cover avoids relying on iOS Safari's native poster rendering. */
(() => {
  "use strict";
  const fallback = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e9f1f3"/><text x="320" y="140" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#385b67">Video memory</text></svg>'
  );
  window.EchoVideo = {
    preview(player) {
      let disposed = false, finished = false;
      const shell = document.createElement("div");
      shell.className = "video-preview-shell";
      player.before(shell);
      shell.append(player);
      const cover = document.createElement("button");
      cover.type = "button";
      cover.className = "video-cover";
      cover.setAttribute("aria-label", "Play " + (player.getAttribute("aria-label") || "video"));
      const image = document.createElement("img");
      image.alt = "";
      image.src = fallback;
      const glyph = document.createElement("span");
      glyph.className = "video-cover-play";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "▶";
      const caption = document.createElement("span");
      caption.className = "video-cover-caption";
      caption.textContent = "Loading preview…";
      cover.append(image, glyph, caption);
      shell.append(cover);
      player.poster = fallback;
      player.dataset.preview = "loading";
      const probe = document.createElement("video");
      probe.crossOrigin = "anonymous";
      probe.preload = "auto";
      probe.muted = probe.defaultMuted = true;
      probe.playsInline = true;
      probe.setAttribute("playsinline", "");
      probe.setAttribute("webkit-playsinline", "");
      probe.setAttribute("aria-hidden", "true");
      probe.tabIndex = -1;
      probe.className = "video-preview-decoder";
      document.body.append(probe);
      const cleanup = () => {
        clearTimeout(timer);
        probe.onloadedmetadata = probe.onloadeddata = probe.onseeked = probe.onplaying = probe.onerror = null;
        probe.pause();
        probe.removeAttribute("src");
        probe.load();
        probe.remove();
      };
      const fail = () => {
        if (disposed || finished) return;
        finished = true;
        player.dataset.preview = "unavailable";
        caption.textContent = "Tap to play video";
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
          const jpeg = canvas.toDataURL("image/jpeg", 0.8);
          image.src = player.poster = jpeg;
          player.dataset.preview = "ready";
          caption.textContent = "Play video";
        } catch {
          player.dataset.preview = "unavailable";
          caption.textContent = "Tap to play video";
        } finally { cleanup(); }
      };
      const timer = setTimeout(fail, 15000);
      probe.onloadedmetadata = () => {
        try { probe.currentTime = Number.isFinite(probe.duration) ? Math.min(0.1, probe.duration / 2) : 0.1; }
        catch { /* loadeddata/playing can still provide a decoded frame. */ }
      };
      probe.onloadeddata = probe.onseeked = probe.onplaying = capture;
      probe.onerror = fail;
      const hideCover = () => {cover.hidden = true;};
      player.addEventListener("play", hideCover);
      cover.addEventListener("click", () => {
        // Keep this call directly inside the gesture for Safari's playback policy.
        const playing = player.play();
        playing?.catch(() => {
          if (disposed) return;
          cover.hidden = false;
          caption.textContent = "Could not play. Tap to retry.";
        });
      });
      player.disposePreview = () => {
        disposed = true;
        cleanup();
        player.removeEventListener("play", hideCover);
        image.removeAttribute("src");
        player.removeAttribute("poster");
      };
      probe.src = player.src;
      probe.load();
      // iOS may not decode offscreen media from preload/seek alone. Prime it silently.
      probe.play()?.catch(() => { /* Native playback still works from the explicit cover button. */ });
    },
  };
})();
