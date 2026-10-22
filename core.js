/* Shared location rules; usable in the browser and Node tests without a map. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EchoCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const RADIUS = 100;
  const APPROACH_RADIUS = 500;
  const MAX_FIX_AGE = 30000;
  function mediaInfo(mime = "") {
    const type = mime.split(";")[0].trim().toLowerCase();
    const formats = {
      "video/webm": ["video", "webm"],
      "video/mp4": ["video", "mp4"],
      "video/quicktime": ["video", "mov"],
      "audio/webm": ["audio", "webm"],
      "audio/mp4": ["audio", "mp4"],
      "audio/x-m4a": ["audio", "m4a"],
      "audio/mpeg": ["audio", "mp3"],
      "audio/wav": ["audio", "wav"],
      "audio/x-wav": ["audio", "wav"],
      "audio/ogg": ["audio", "ogg"],
    };
    const pair = formats[type];
    return pair
      ? {
          type,
          kind: pair[0],
          extension: pair[1],
          maxBytes: (pair[0] === "video" ? 20 : 8) * 1024 * 1024,
          maxSeconds: pair[0] === "video" ? 30 : 60,
        }
      : null;
  }
  function importMediaInfo(mime = "", filename = "", expectedKind) {
    const type = mime.split(";")[0].trim().toLowerCase();
    const aliases = {"video/x-m4v":"video/mp4", "video/mov":"video/quicktime", "video/x-quicktime":"video/quicktime", "audio/x-mp3":"audio/mpeg"};
    let info = mediaInfo(aliases[type] || type);
    if (!info && ["", "application/octet-stream", "binary/octet-stream", "application/mp4"].includes(type)) {
      const ext = filename.toLowerCase().split(".").pop();
      const types = expectedKind === "video"
        ? {mp4:"video/mp4", m4v:"video/mp4", mov:"video/quicktime", webm:"video/webm"}
        : {m4a:"audio/mp4", mp4:"audio/mp4", mp3:"audio/mpeg", wav:"audio/wav", ogg:"audio/ogg", webm:"audio/webm"};
      info = mediaInfo(types[ext]);
    }
    return info?.kind === expectedKind ? info : null;
  }
  const MAX_ATTACHMENTS = 8;
  const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
  function attachments(e) {
    if (Array.isArray(e.attachments) && e.attachments.length)
      return e.attachments;
    if (e.photoId || e.photoPath)
      return [
        { id: e.photoId || e.id, kind: "photo", path: e.photoPath || null },
      ];
    if (e.mediaId || e.mediaPath)
      return [
        { id: e.mediaId || e.id, kind: e.mediaKind, path: e.mediaPath || null },
      ];
    return [];
  }
  function validAttachments(e) {
    if (
      e.attachments == null ||
      (Array.isArray(e.attachments) && !e.attachments.length)
    )
      return true;
    if (
      !Array.isArray(e.attachments) ||
      e.attachments.length > MAX_ATTACHMENTS ||
      e.photoId ||
      e.photoPath ||
      e.mediaId ||
      e.mediaPath ||
      e.mediaKind
    )
      return false;
    const ids = new Set();
    return e.attachments.every((a) => {
      if (
        !a ||
        typeof a.id !== "string" ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(a.id) ||
        ids.has(a.id) ||
        !["photo", "audio", "video"].includes(a.kind) ||
        (a.path != null &&
          (typeof a.path !== "string" || !a.path.length || a.path.length > 240))
      )
        return false;
      ids.add(a.id);
      return true;
    });
  }
  function validCoordinates(p) {
    return (
      !!p &&
      Number.isFinite(p.lat) &&
      Math.abs(p.lat) <= 90 &&
      Number.isFinite(p.lng) &&
      Math.abs(p.lng) <= 180
    );
  }
  function metres(a, b) {
    const rad = Math.PI / 180;
    const h =
      Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
      Math.cos(a.lat * rad) *
        Math.cos(b.lat * rad) *
        Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  }
  function freshFix(fix, now = Date.now()) {
    return (
      validCoordinates(fix) &&
      Number.isFinite(fix.accuracy) &&
      fix.accuracy >= 0 &&
      Number.isFinite(fix.timestamp) &&
      now - fix.timestamp >= 0 &&
      now - fix.timestamp < MAX_FIX_AGE
    );
  }
  function canCreate(fix, now = Date.now()) {
    return freshFix(fix, now) && fix.accuracy <= RADIUS;
  }
  function discovery(echo, fix, now = Date.now()) {
    if (!freshFix(fix, now)) return { state: "unavailable", distance: null, proximity: 0 };
    const distance = metres(fix, echo);
    // The reported accuracy is an estimate, not proof of physical presence.
    const state =
      distance > RADIUS
        ? "locked"
        : distance + fix.accuracy <= RADIUS
          ? "unlocked"
          : "uncertain";
    // Emphasis grows over the approach; reported uncertainty softens the signal.
    const proximity = Math.max(0, Math.min(1,
      (APPROACH_RADIUS - distance - fix.accuracy) / (APPROACH_RADIUS - RADIUS),
    ));
    return { state, distance, proximity };
  }
  function validEcho(e) {
    return (
      validCoordinates(e) &&
      validAttachments(e) &&
      ((e.mediaKind == null && !e.mediaId && !e.mediaPath) ||
        (["audio", "video"].includes(e.mediaKind) &&
          typeof (e.mediaId || e.mediaPath) === "string" &&
          (e.mediaId || e.mediaPath).length <= 240 &&
          !(e.photoId || e.photoPath))) &&
      typeof e.id === "string" &&
      e.id.length > 0 &&
      e.id.length <= 100 &&
      typeof e.title === "string" &&
      e.title.trim().length > 0 &&
      e.title.length <= 65 &&
      typeof e.story === "string" &&
      e.story.trim().length > 0 &&
      e.story.length <= 1200 &&
      typeof e.createdAt === "string" &&
      Number.isFinite(Date.parse(e.createdAt))
    );
  }
  return {
    MAX_ATTACHMENTS,
    MAX_TOTAL_BYTES,
    attachments,
    mediaInfo,
    importMediaInfo,
    RADIUS,
    APPROACH_RADIUS,
    MAX_FIX_AGE,
    validCoordinates,
    metres,
    freshFix,
    canCreate,
    discovery,
    validEcho,
  };
});
