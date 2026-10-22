/* Media preparation and per-origin blob storage. Existing photo store preserved. */
(() => {
  "use strict";
  const MAX_INPUT = 10 * 1024 * 1024;
  const MAX_OUTPUT = 1500 * 1024;
  let database;
  function open() {
    if (!database)
      database = new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          reject(new Error("Media storage is not supported in this browser."));
          return;
        }
        const request = indexedDB.open("urban-echo-media", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("photos");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(
            new Error(
              "Media storage is unavailable. Your memory has not been saved.",
            ),
          );
        request.onblocked = () =>
          reject(
            new Error(
              "Media storage is blocked. Close other Urban Echo tabs and retry.",
            ),
          );
      });
    return database;
  }
  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("photos", mode);
      let result;
      const request = action(tx.objectStore("photos"));
      request.onsuccess = () => {
        result = request.result;
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () =>
        reject(
          new Error(
            "Media storage is unavailable or full. Your draft is still here.",
          ),
        );
    });
  }
  async function decode(file) {
    if (window.createImageBitmap) return createImageBitmap(file);
    const url = URL.createObjectURL(file),
      image = new Image();
    try {
      image.src = url;
      await image.decode();
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function prepare(file) {
    if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw new Error(
        "Choose a JPEG, PNG or WebP photo. HEIC and other formats need converting first.",
      );
    if (!file.size || file.size > MAX_INPUT)
      throw new Error("Choose a photo smaller than 10 MB.");
    let image;
    try {
      image = await decode(file);
    } catch {
      throw new Error(
        "This photo could not be opened. Try another JPEG, PNG or WebP image.",
      );
    }
    try {
      if (
        !image.width ||
        !image.height ||
        image.width * image.height > 40000000
      )
        throw new Error(
          "This photo is too large to process. Choose one under 40 megapixels.",
        );
      const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("This browser could not prepare the photo.");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      // Re-encoding creates a fresh image, without retaining the original EXIF/GPS metadata.
      for (const quality of [0.86, 0.7, 0.54]) {
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", quality),
        );
        if (blob && blob.size <= MAX_OUTPUT) return blob;
      }
      throw new Error(
        "This photo is still too large after compression. Try a smaller image.",
      );
    } finally {
      image.close?.();
    }
  }
  async function prepareClip(file, expectedKind, recordedDuration) {
    const info = window.EchoCore.importMediaInfo(file?.type, file?.name, expectedKind);
    if (!info)
      throw new Error("Choose a supported " + expectedKind + " file. Try MP4, MOV or WebM for video; M4A, MP3, WAV, Ogg or WebM for audio.");
    if (!file.size || file.size > info.maxBytes)
      throw new Error("This " + expectedKind + " is " + (file.size / 1024 / 1024).toFixed(1) + " MB. Choose a file up to " + info.maxBytes / 1024 / 1024 + " MB.");
    // File pickers may omit a type or supply a platform alias. Use a normalised
    // Blob for metadata/loading, then let the browser verify the actual content.
    const blob = file.slice(0, file.size, info.type);
    const url = URL.createObjectURL(blob);
    const player = document.createElement(expectedKind);
    player.preload = "auto";
    player.muted = player.defaultMuted = true;
    player.playsInline = true;
    player.setAttribute("playsinline", "");
    player.setAttribute("aria-hidden", "true");
    player.tabIndex = -1;
    player.style.cssText = "position:fixed;left:-2px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.append(player);
    let timer, poll, duration;
    try {
      duration = await new Promise((resolve, reject) => {
        let metadata = false, scanning = false;
        const check = () => {
          const length = recordedDuration ?? player.duration;
          if (metadata && Number.isFinite(length) && length > 0) resolve(length);
        };
        timer = setTimeout(() => reject(new Error("The duration of this file could not be read. Try a short MP4 export, then choose it again.")), 15000);
        poll = setInterval(check, 150);
        player.onloadedmetadata = () => {
          metadata = true;
          check();
          // Some imported WebM clips have no duration header. Scanning to the
          // end lets the browser report the real duration; it is still validated.
          if (!recordedDuration && !Number.isFinite(player.duration) && info.type.endsWith("webm") && !scanning) {
            scanning = true;
            try { player.currentTime = 1e9; } catch { /* Wait for durationchange. */ }
          }
        };
        player.ondurationchange = player.onloadeddata = player.onseeked = check;
        player.onerror = () => reject(new Error("This browser cannot open this video/audio format. Try exporting a short MP4 video or M4A audio file."));
        player.src = url;
        player.load();
      });
      if (duration > info.maxSeconds + 0.5)
        throw new Error("This " + expectedKind + " is " + Math.ceil(duration) + " seconds long. Choose a clip up to " + info.maxSeconds + " seconds.");
      return blob;
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      player.onloadedmetadata = player.ondurationchange = player.onloadeddata = player.onseeked = player.onerror = null;
      player.pause();
      player.removeAttribute("src");
      player.load();
      player.remove();
      URL.revokeObjectURL(url);
    }
  }
  window.EchoMedia = {
    prepareClip,
    prepare,
    put: (id, blob) => transaction("readwrite", (store) => store.put(blob, id)),
    get: (id) => transaction("readonly", (store) => store.get(id)),
    remove: (id) => transaction("readwrite", (store) => store.delete(id)),
  };
})();
