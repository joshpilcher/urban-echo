-- Additive upgrade: existing photos and stories remain valid.
alter table public.urban_echoes add column media_kind text;
alter table public.urban_echoes add column media_path text;
alter table public.urban_echoes add constraint urban_echo_recording_attachment check (
  (media_kind is null and media_path is null) or
  (media_kind is not null and media_path is not null and photo_path is null and
    ((media_kind = 'video' and media_path in (owner_id::text || '/' || id::text || '.mp4', owner_id::text || '/' || id::text || '.webm', owner_id::text || '/' || id::text || '.mov')) or
     (media_kind = 'audio' and media_path in (owner_id::text || '/' || id::text || '.mp4', owner_id::text || '/' || id::text || '.webm', owner_id::text || '/' || id::text || '.m4a', owner_id::text || '/' || id::text || '.mp3', owner_id::text || '/' || id::text || '.wav', owner_id::text || '/' || id::text || '.ogg'))))
);
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('urban-echo-recordings','urban-echo-recordings',true,20971520,array['video/mp4','video/webm','video/quicktime','audio/mp4','audio/x-m4a','audio/mpeg','audio/wav','audio/x-wav','audio/ogg','audio/webm']);
create policy "Urban Echo recording upload" on storage.objects for insert to authenticated
with check (bucket_id = 'urban-echo-recordings' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Urban Echo recording owner read" on storage.objects for select to authenticated
using (bucket_id = 'urban-echo-recordings' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Urban Echo recording owner delete" on storage.objects for delete to authenticated
using (bucket_id = 'urban-echo-recordings' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- No UPDATE/upsert policy. Public URLs are public; proximity is a UI interaction.
