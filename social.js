/* Public interactions; GPS gates the interface, RLS protects authorship. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id), Cloud = window.EchoCloud;
  const drafts = new Map();
  let current = null, contextKey = "", revision = 0, busy = false, loading = false;
  let state = null, activityRevision = 0;
  const el = (tag, cls, text) => {const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
  const date = value => new Date(value).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
  function allowed() { return current?.source === "shared" && current.state === "unlocked" && Cloud.available; }
  function controls() {
    $("echo-like").disabled = !allowed() || busy || loading || !state || current.ownerId === Cloud.userId;
    $("reply-submit").disabled = !allowed() || busy || loading || !state;
    $("social-refresh").disabled = busy || loading;
    $("replies-more").disabled = busy || loading;
    $("reply-body").disabled = !allowed() || busy;
    document.querySelectorAll(".reply-delete").forEach(b=>b.disabled=busy || loading || !allowed());
  }
  function paint() {
    $("echo-like").textContent = (state.liked ? "♥ Liked" : "♡ Like") + " · " + state.count;
    $("echo-like").setAttribute("aria-pressed",String(state.liked));
    $("echo-like").setAttribute("aria-label",(state.liked ? "Unlike" : "Like")+" this Echo, "+state.count+" likes");
    $("reply-list").replaceChildren();
    for (const r of state.replies) {
      const row=el("article","reply-card","");
      row.append(el("strong","reply-author",r.user_id===Cloud.userId ? "You" : "A nearby visitor"),el("time","reply-date",date(r.created_at)),el("p","reply-text",r.body));
      if (r.user_id===Cloud.userId) {
        const b=el("button","text-button danger reply-delete","Delete reply"); b.type="button";
        b.addEventListener("click",()=>mutate(()=>Cloud.removeReply(r.id)));
        row.append(b);
      }
      $("reply-list").append(row);
    }
    $("social-status").textContent=state.replies.length ? "" : "Be the first to leave a reply.";
    $("replies-more").hidden=!state.more;
    controls();
  }
  async function refresh(append=false) {
    if (!allowed()) return;
    const token=revision,id=current.id;
    loading=true; controls();$("social-error").textContent="";
    if (!append) $("social-status").textContent="Loading replies…";
    try {
      const last=append ? state?.replies.at(-1) : null;
      const next=await Cloud.interactions(id,last);
      if (token!==revision || !allowed()) return;
      state=append ? {...next,replies:[...state.replies,...next.replies]} : next;
      paint();
    } catch(e) {
      if(token===revision) {$("social-error").textContent=e.message;$("social-status").textContent="";}
    } finally {if(token===revision){loading=false;controls();}}
  }
  async function mutate(work, after) {
    if(!allowed() || busy || loading) return;
    const token=revision;busy=true;controls();$("social-error").textContent="";
    try {
      await work();
      after?.();
      if(token===revision && allowed()) await refresh();
    } catch(e){if(token===revision) $("social-error").textContent=e.message;}
    finally {busy=false;controls();}
  }
  function update(e) {
    current=e;
    const next=e ? e.id+":"+e.state+":"+e.source : "closed";
    $("echo-social").hidden=!allowed();
    $("social-unavailable").textContent=!e ? "" : e.source!=="shared" ? "Share a public Echo to receive likes and replies. Device-only memories stay private." : !allowed() ? "Walk within reach to like this Echo or join the conversation." : "";
    if(next!==contextKey) {
      contextKey=next;revision++;state=null;loading=false;
      $("reply-list").replaceChildren();$("social-error").textContent="";$("social-status").textContent="";
      $("echo-like").textContent="♡ Like · —";$("replies-more").hidden=true;
      $("reply-body").value=drafts.get(e?.id)?.body || "";
      if(allowed()) refresh();
    }
    controls();
  }
  $("reply-body").addEventListener("input",()=>{
    if(!current) return;
    const old=drafts.get(current.id);
    drafts.set(current.id,{id:old?.id || crypto.randomUUID(),body:$("reply-body").value});
  });
  $("reply-form").addEventListener("submit",event=>{
    event.preventDefault();if(!allowed() || !state) return;
    const id=current.id, draft=drafts.get(id) || {id:crypto.randomUUID(),body:$("reply-body").value};
    if(!draft.body.trim()) {$("social-error").textContent="Write a reply first.";return;}
    drafts.set(id,draft);
    mutate(()=>Cloud.reply(id,draft.id,draft.body),()=>{
      drafts.delete(id);if(current?.id===id) $("reply-body").value="";
    });
  });
  $("echo-like").addEventListener("click",()=>{if(state) {const id=current.id,liked=!state.liked;mutate(()=>Cloud.like(id,liked));}});
  $("social-refresh").addEventListener("click",()=>refresh());
  $("replies-more").addEventListener("click",()=>refresh(true));
  async function activity(openDetail) {
    const token=++activityRevision;
    $("activity-refresh").disabled=true;$("activity-status").textContent="Loading activity…";$("activity-list").replaceChildren();
    try {
      const rows=await Cloud.activity();if(token!==activityRevision)return;
      $("activity-status").textContent=rows.length ? "Latest likes and replies · refresh for updates" : Cloud.available ? "Quiet for now. Likes and replies to your public Echoes will appear here." : "Activity is available when public sharing is connected.";
      for(const r of rows) {
        const card=el("article","activity-card","");
        card.append(el("span","activity-symbol",r.kind==="like" ? "♥" : "↩"),el("p","activity-copy",r.kind==="like" ? "A visitor liked your Echo" : "A visitor replied to your Echo"));
        const b=el("button","activity-echo",r.urban_echoes.title);b.type="button";
        b.addEventListener("click",()=>openDetail(r.echo_id));card.append(b);
        if(r.kind==="reply")card.append(el("p","reply-text",r.body));
        card.append(el("time","reply-date",date(r.created_at)));$("activity-list").append(card);
      }
    } catch(e){if(token===activityRevision)$("activity-status").textContent=e.message;}
    finally {if(token===activityRevision)$("activity-refresh").disabled=false;}
  }
  window.EchoSocial={update,activity};
})();
