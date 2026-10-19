-- Urban Echo prototype: public contributions, authenticated creator ownership.
-- Apply to the chosen Supabase project. Enable Anonymous Sign-Ins in Auth.
create table if not exists public.urban_echoes (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 65),
  story text not null check (char_length(trim(story)) between 1 and 1200),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  photo_path text check (photo_path is null or photo_path = owner_id::text || '/' || id::text || '.jpg'),
  created_at timestamptz not null default now()
);
create index if not exists urban_echoes_created_at_idx on public.urban_echoes (created_at desc);
create index if not exists urban_echoes_owner_id_idx on public.urban_echoes (owner_id);
alter table public.urban_echoes enable row level security;
grant select on public.urban_echoes to anon, authenticated;
grant insert, delete on public.urban_echoes to authenticated;
revoke update on public.urban_echoes from anon, authenticated;
create policy "Urban Echo public read" on public.urban_echoes for select to anon, authenticated using (true);
create policy "Urban Echo owner create" on public.urban_echoes for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "Urban Echo owner delete" on public.urban_echoes for delete to authenticated using ((select auth.uid()) = owner_id);

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('urban-echo-photos','urban-echo-photos',true,1572864,array['image/jpeg'])
on conflict (id) do nothing;
create policy "Urban Echo photo upload" on storage.objects for insert to authenticated
with check (bucket_id = 'urban-echo-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Urban Echo photo owner read" on storage.objects for select to authenticated
using (bucket_id = 'urban-echo-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Urban Echo photo owner delete" on storage.objects for delete to authenticated
using (bucket_id = 'urban-echo-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- Public bucket URLs can be viewed by anyone who knows the URL. The 100m rule
-- is an in-app discovery interaction, not a protection for confidential data.
