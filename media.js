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
    const info = window.EchoCore.mediaInfo(file?.type);
    if (!info || info.kind !== expectedKind)
      throw new Error(
        "Choose a supported " +
          expectedKind +
          " file. Try MP4 or WebM for video; M4A, MP3, WAV, Ogg or WebM for audio.",
      );
    if (!file.size || file.size > info.maxBytes)
      throw new Error(
        "Choose " +
          expectedKind +
          " smaller than " +
          info.maxBytes / 1024 / 1024 +
          " MB.",
      );
    const url = URL.createObjectURL(file);
    const player = document.createElement(expectedKind);
    player.preload = "metadata";
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error("This file could not be opened. Try another format."),
            ),
          12000,
        );
        player.onloadedmetadata = () => {
          clearTimeout(timer);
          resolve();
        };
        player.onerror = () => {
          clearTimeout(timer);
          reject(
            new Error(
              "This browser cannot play this file. Try another format.",
            ),
          );
        };
        player.src = url;
      });
      // Recorded WebM can report Infinity until fully scanned. Our recorder supplies elapsed time.
      const duration = recordedDuration ?? player.duration;
      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > info.maxSeconds + 0.5
      )
        throw new Error(
          "Choose a clip up to " +
            info.maxSeconds +
            " seconds with a readable duration.",
        );
      return file.slice(0, file.size, info.type);
    } finally {
      player.removeAttribute("src");
      player.load();
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
