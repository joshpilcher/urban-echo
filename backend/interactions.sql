-- Additive social layer. Public Echo interactions are public content.
-- The 100 m rule is a client interaction, not proof of physical presence.
begin;
create table public.urban_echo_likes (
  echo_id uuid not null references public.urban_echoes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (echo_id,user_id)
);
create index urban_echo_likes_user_idx on public.urban_echo_likes(user_id);
create table public.urban_echo_replies (
  id uuid primary key,
  echo_id uuid not null references public.urban_echoes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);
create index urban_echo_replies_echo_time_idx on public.urban_echo_replies(echo_id,created_at desc);
create index urban_echo_replies_user_idx on public.urban_echo_replies(user_id);
alter table public.urban_echo_likes enable row level security;
alter table public.urban_echo_replies enable row level security;
revoke all on public.urban_echo_likes, public.urban_echo_replies from anon,authenticated;
grant select on public.urban_echo_likes, public.urban_echo_replies to anon,authenticated;
grant insert,delete on public.urban_echo_likes, public.urban_echo_replies to authenticated;
create policy "Public likes" on public.urban_echo_likes for select to anon,authenticated using (true);
create policy "Own like insert" on public.urban_echo_likes for insert to authenticated with check (
 (select auth.uid())=user_id and exists(select 1 from public.urban_echoes e where e.id=echo_id and e.owner_id<>(select auth.uid()))
);
create policy "Own like delete" on public.urban_echo_likes for delete to authenticated using ((select auth.uid())=user_id);
create policy "Public replies" on public.urban_echo_replies for select to anon,authenticated using (true);
create policy "Own reply insert" on public.urban_echo_replies for insert to authenticated with check (
 (select auth.uid())=user_id and exists(select 1 from public.urban_echoes e where e.id=echo_id and e.owner_id<>(select auth.uid()))
);
create policy "Own reply delete" on public.urban_echo_replies for delete to authenticated using ((select auth.uid())=user_id);
commit;
