/* Shared Echo adapter. The publishable key is public; ownership is enforced by RLS. */
(() => {
  "use strict";
  const config = window.URBAN_ECHO_CONFIG || {};
  const bucket = "urban-echo-photos";
  const table = "urban_echoes";
  let client = null,
    currentUser = null;
  try {
    const url = new URL(config.supabaseUrl || "invalid:");
    const key = config.supabasePublishableKey || "";
    if (url.protocol === "https:" && key && !key.startsWith("sb_secret_")) {
      // Legacy service-role JWTs must never be used by a browser, either.
      let role = null;
      if (key.split(".").length === 3) {
        try {
          role = JSON.parse(
            atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
          ).role;
        } catch {
          /* SDK will reject invalid keys. */
        }
      }
      if (role !== "service_role" && window.supabase?.createClient)
        client = window.supabase.createClient(url.origin, key);
    }
  } catch {
    /* Unconfigured builds keep the private local workflow available. */
  }
  function normalise(row) {
    const echo = {
      id: row.id,
      title: row.title,
      story: row.story,
      lat: row.lat,
      lng: row.lng,
      createdAt: row.created_at,
      source: "shared",
      ownerId: row.owner_id,
      photoPath: row.photo_path || null,
    };
    return window.EchoCore.validEcho(echo) ? echo : null;
  }
  async function identify() {
    if (!client)
      throw new Error(
        "Public sharing is not connected yet. Save on this device instead.",
      );
    let { data, error } = await client.auth.getSession();
    if (error)
      throw new Error(
        "Your sharing session could not be read. Retry, or save on this device.",
      );
    let session = data.session;
    if (!session) {
      const result = await client.auth.signInAnonymously();
      if (result.error)
        throw new Error(
          "Public sharing could not start. Please retry; your draft is still here.",
        );
      session = result.data.session;
    }
    currentUser = session?.user || null;
    if (!currentUser)
      throw new Error(
        "Your sharing session is unavailable. Your draft is still here.",
      );
    return currentUser;
  }
  async function load() {
    if (!client) return [];
    const session = await client.auth.getSession();
    currentUser = session.data?.session?.user || null;
    const { data, error } = await client
      .from(table)
      .select("id,title,story,lat,lng,created_at,owner_id,photo_path")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error)
      throw new Error(
        "Shared Echoes could not load. Check your connection and try Refresh.",
      );
    return (data || []).map(normalise).filter(Boolean);
  }
  async function create(echo, photo) {
    const user = await identify();
    let photoPath = null;
    if (photo) {
      photoPath = user.id + "/" + echo.id + ".jpg";
      const { error } = await client.storage
        .from(bucket)
        .upload(photoPath, photo, {
          contentType: "image/jpeg",
          cacheControl: "3600",
          upsert: false,
        });
      if (error && String(error.statusCode) !== "409")
        throw new Error(
          "The photo could not upload. Check your connection and retry; your draft is still here.",
        );
    }
    const row = {
      id: echo.id,
      owner_id: user.id,
      title: echo.title,
      story: echo.story,
      lat: echo.lat,
      lng: echo.lng,
      photo_path: photoPath,
    };
    const { data, error } = await client
      .from(table)
      .insert(row)
      .select()
      .single();
    if (error) {
      // An insert may have committed even if its network response was lost.
      // Reconcile before cleanup so a successful Echo never loses its photo.
      const existing = await client
        .from(table)
        .select()
        .eq("id", echo.id)
        .eq("owner_id", user.id)
        .maybeSingle();
      if (!existing.error && existing.data) return normalise(existing.data);
      if (!existing.error && photoPath)
        await client.storage
          .from(bucket)
          .remove([photoPath])
          .catch(() => {});
      throw new Error(
        "Your Echo could not be shared. Your draft is still here; please retry.",
      );
    }
    const result = normalise(data);
    if (!result)
      throw new Error(
        "The shared Echo response was invalid. Refresh before trying again.",
      );
    return result;
  }
  async function remove(echo) {
    const user = await identify();
    if (echo.ownerId !== user.id)
      throw new Error("Only the creator can delete this Echo.");
    // Remove the photo first. A failure leaves the visible Echo intact for a retry.
    if (echo.photoPath) {
      const result = await client.storage.from(bucket).remove([echo.photoPath]);
      if (result.error)
        throw new Error(
          "The photo could not be removed. Your Echo has not been deleted. Please retry.",
        );
    }
    const { error } = await client
      .from(table)
      .delete()
      .eq("id", echo.id)
      .eq("owner_id", user.id);
    if (error)
      throw new Error(
        "Your Echo could not be deleted. Check your connection and retry.",
      );
  }
  window.EchoCloud = {
    get available() {
      return !!client;
    },
    get userId() {
      return currentUser?.id || null;
    },
    load,
    create,
    remove,
    photoURL: (echo) =>
      client && echo.photoPath
        ? client.storage.from(bucket).getPublicUrl(echo.photoPath).data
            .publicUrl
        : null,
  };
})();
