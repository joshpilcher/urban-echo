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
      attachments: row.attachments || [],
      photoPath: row.photo_path || null,
      mediaKind: row.media_kind || null,
      mediaPath: row.media_path || null,
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
      .select(
        "id,title,story,lat,lng,created_at,owner_id,photo_path,media_kind,media_path,attachments",
      )
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
    const info = echo.mediaKind ? window.EchoCore.mediaInfo(photo?.type) : null;
    if (
      echo.mediaKind &&
      (!info ||
        info.kind !== echo.mediaKind ||
        !photo.size ||
        photo.size > info.maxBytes)
    )
      throw new Error(
        "This recording is unsupported or too large. Choose another file.",
      );
    const targetBucket = info ? "urban-echo-recordings" : bucket;
    const mediaPath = info
      ? user.id + "/" + echo.id + "." + info.extension
      : null;
    if (photo) {
      photoPath = info ? null : user.id + "/" + echo.id + ".jpg";
      const { error } = await client.storage
        .from(targetBucket)
        .upload(mediaPath || photoPath, photo, {
          contentType: info?.type || "image/jpeg",
          cacheControl: "3600",
          upsert: false,
        });
      if (error && String(error.statusCode) !== "409")
        throw new Error(
          "The " +
            (info ? "recording" : "photo") +
            " could not upload. Check your connection and retry; your draft is still here.",
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
      media_kind: info?.kind || null,
      media_path: mediaPath,
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
      if (!existing.error && (photoPath || mediaPath))
        await client.storage
          .from(targetBucket)
          .remove([mediaPath || photoPath])
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
  async function createCollection(echo, attachments) {
    const Core = window.EchoCore;
    if (
      !Array.isArray(attachments) ||
      attachments.length > Core.MAX_ATTACHMENTS ||
      attachments.reduce((sum, a) => sum + (a.blob?.size || 0), 0) >
        Core.MAX_TOTAL_BYTES
    )
      throw new Error(
        "Choose up to 8 attachments, totalling no more than 50 MB.",
      );
    const user = await identify();
    const uploads = attachments.map((a) => {
      const info =
        a.kind === "photo"
          ? {
              kind: "photo",
              extension: "jpg",
              type: "image/jpeg",
              maxBytes: 1500 * 1024,
            }
          : Core.mediaInfo(a.blob?.type);
      if (
        !info ||
        info.kind !== a.kind ||
        !a.blob?.size ||
        a.blob.size > info.maxBytes ||
        a.blob.type.split(";")[0] !== info.type ||
        !/^[0-9a-f-]{36}$/.test(a.id)
      )
        throw new Error(
          "An attachment is invalid or too large. Your draft is still here.",
        );
      return {
        id: a.id,
        kind: a.kind,
        path: user.id + "/" + echo.id + "/" + a.id + "." + info.extension,
        blob: a.blob,
        type: info.type,
        bucket: a.kind === "photo" ? bucket : "urban-echo-recordings",
      };
    });
    if (new Set(uploads.map((a) => a.id)).size !== uploads.length)
      throw new Error("Attachment IDs must be unique.");
    const attempted = [];
    try {
      for (let i = 0; i < uploads.length; i++) {
        const a = uploads[i];
        attempted.push(a);
        const { error } = await client.storage
          .from(a.bucket)
          .upload(a.path, a.blob, {
            contentType: a.type,
            cacheControl: "3600",
            upsert: false,
          });
        if (error && String(error.statusCode) !== "409")
          throw new Error(
            "Attachment " +
              (i + 1) +
              " could not upload. Check your connection and retry; your draft is still here.",
          );
      }
      const row = {
        id: echo.id,
        owner_id: user.id,
        title: echo.title,
        story: echo.story,
        lat: echo.lat,
        lng: echo.lng,
        attachments: uploads.map(({ id, kind, path }) => ({ id, kind, path })),
      };
      const { data, error } = await client
        .from(table)
        .insert(row)
        .select()
        .single();
      if (error)
        throw new Error(
          "Your Echo could not be shared. Your draft is still here; please retry.",
        );
      const result = normalise(data);
      if (!result)
        throw new Error(
          "The shared Echo response was invalid. Refresh before trying again.",
        );
      return result;
    } catch (error) {
      // Reconcile lost responses before deleting any file, including a failed upload
      // that may have reached Storage. Preserve files if the outcome is unknown.
      const existing = await client
        .from(table)
        .select()
        .eq("id", echo.id)
        .eq("owner_id", user.id)
        .maybeSingle();
      if (!existing.error && existing.data) {
        const saved = normalise(existing.data);
        if (saved) return saved;
      }
      if (!existing.error && !existing.data) {
        for (const name of [bucket, "urban-echo-recordings"]) {
          const paths = attempted
            .filter((a) => a.bucket === name)
            .map((a) => a.path);
          if (paths.length)
            await client.storage
              .from(name)
              .remove(paths)
              .catch(() => {});
        }
      }
      throw error;
    }
  }
  async function remove(echo) {
    const user = await identify();
    if (echo.ownerId !== user.id)
      throw new Error("Only the creator can delete this Echo.");
    // Remove every object before the row. Any failure retains the row for retry.
    for (const kind of ["photo", "recording"]) {
      const paths = window.EchoCore.attachments(echo)
        .filter((a) =>
          kind === "photo" ? a.kind === "photo" : a.kind !== "photo",
        )
        .map((a) => a.path)
        .filter(Boolean);
      if (!paths.length) continue;
      const result = await client.storage
        .from(kind === "photo" ? bucket : "urban-echo-recordings")
        .remove(paths);
      if (result.error)
        throw new Error(
          "The attachment could not be removed. Your Echo has not been deleted. Please retry.",
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
  async function interactions(echoId, before = null) {
    if (!client) throw new Error("Shared interactions are unavailable.");
    const session = await client.auth.getSession();
    currentUser = session.data?.session?.user || null;
    let replies = client.from("urban_echo_replies").select("id,echo_id,user_id,body,created_at")
      .eq("echo_id", echoId).order("created_at", {ascending: false}).order("id", {ascending: false}).limit(51);
    if (before) replies = replies.or("created_at.lt."+before.created_at+",and(created_at.eq."+before.created_at+",id.lt."+before.id+")");
    const [count, mine, thread] = await Promise.all([
      client.from("urban_echo_likes").select("echo_id", {count: "exact", head: true}).eq("echo_id", echoId),
      currentUser ? client.from("urban_echo_likes").select("user_id").eq("echo_id", echoId).eq("user_id", currentUser.id) : Promise.resolve({data: []}),
      replies
    ]);
    if (count.error || mine.error || thread.error) throw new Error("Interactions could not load. Tap Refresh to retry.");
    return {count: count.count || 0, liked: !!mine.data?.length, replies: (thread.data || []).slice(0,50), more: (thread.data || []).length > 50};
  }
  async function like(echoId, liked) {
    const user = await identify();
    const result = liked
      ? await client.from("urban_echo_likes").upsert({echo_id: echoId, user_id: user.id}, {onConflict: "echo_id,user_id", ignoreDuplicates: true})
      : await client.from("urban_echo_likes").delete().eq("echo_id",echoId).eq("user_id",user.id);
    if (result.error) throw new Error("Your like could not be saved. Refresh to check, then retry.");
  }
  async function reply(echoId, id, body) {
    body = body.trim();
    if (!body || [...body].length > 500) throw new Error("Write a reply of 1–500 characters.");
    const user = await identify();
    const result = await client.from("urban_echo_replies").insert({id,echo_id:echoId,user_id:user.id,body});
    if (result.error) {
      const existing = await client.from("urban_echo_replies").select("id").eq("id",id).eq("user_id",user.id).maybeSingle();
      if (!existing.error && existing.data) return;
      throw new Error("Your reply could not be saved. Your draft is still here; retry when connected.");
    }
  }
  async function removeReply(id) {
    const user = await identify();
    const result = await client.from("urban_echo_replies").delete().eq("id",id).eq("user_id",user.id);
    if (result.error) throw new Error("Your reply could not be deleted. Please retry.");
  }
  async function activity() {
    if (!client) return [];
    const session = await client.auth.getSession();
    currentUser = session.data?.session?.user || null;
    if (!currentUser) return [];
    const uid = currentUser.id;
    const results = await Promise.all(["urban_echo_likes","urban_echo_replies"].map(name =>
      client.from(name).select("*,urban_echoes!inner(id,title,owner_id)").eq("urban_echoes.owner_id",uid)
        .neq("user_id",uid).order("created_at",{ascending:false}).limit(100)
    ));
    if (results.some(r=>r.error)) throw new Error("Activity could not load. Check your connection and refresh.");
    return results.flatMap((r,i)=>(r.data || []).map(item=>({...item,kind:i ? "reply" : "like"})))
      .sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)).slice(0,100);
  }
  window.EchoCloud = {
    get available() {
      return !!client;
    },
    get userId() {
      return currentUser?.id || null;
    },
    load,
    interactions, like, reply, removeReply, activity,
    create,
    createCollection,
    attachmentURL: (attachment) =>
      client && attachment.path
        ? client.storage
            .from(
              attachment.kind === "photo" ? bucket : "urban-echo-recordings",
            )
            .getPublicUrl(attachment.path).data.publicUrl
        : null,
    remove,
    mediaURL: (echo) =>
      client && (echo.mediaPath || echo.photoPath)
        ? client.storage
            .from(echo.mediaPath ? "urban-echo-recordings" : bucket)
            .getPublicUrl(echo.mediaPath || echo.photoPath).data.publicUrl
        : null,
    photoURL: (echo) =>
      client && echo.photoPath
        ? client.storage.from(bucket).getPublicUrl(echo.photoPath).data
            .publicUrl
        : null,
  };
})();
