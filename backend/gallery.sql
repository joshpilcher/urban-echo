-- Additive gallery storage; old single-attachment columns remain readable.
create function public.urban_echo_valid_gallery(items jsonb, creator uuid, echo_id uuid)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare item jsonb; attachment_id text; kind text; path text; extensions text[]; seen text[] := '{}';
begin
  if items is null or jsonb_typeof(items) <> 'array' then return false; end if;
  if jsonb_array_length(items) > 8 then return false; end if;
  for item in select value from jsonb_array_elements(items) loop
    if jsonb_typeof(item) <> 'object' then return false; end if;
    attachment_id := item->>'id'; kind := item->>'kind'; path := item->>'path';
    if attachment_id is null or kind is null or path is null then return false; end if;
    if attachment_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or attachment_id = any(seen) then return false; end if;
    seen := array_append(seen, attachment_id);
    extensions := case kind when 'photo' then array['jpg'] when 'video' then array['mp4','webm','mov'] when 'audio' then array['mp4','webm','m4a','mp3','wav','ogg'] else null end;
    if extensions is null or not exists (select 1 from unnest(extensions) ext where path = creator::text || '/' || echo_id::text || '/' || attachment_id || '.' || ext) then return false; end if;
  end loop;
  return true;
end;
$$;
revoke execute on function public.urban_echo_valid_gallery(jsonb,uuid,uuid) from public;
grant execute on function public.urban_echo_valid_gallery(jsonb,uuid,uuid) to anon, authenticated;
alter table public.urban_echoes add column attachments jsonb not null default '[]'::jsonb;
alter table public.urban_echoes add constraint urban_echo_gallery_check check (
  public.urban_echo_valid_gallery(attachments, owner_id, id) and
  (attachments = '[]'::jsonb or (photo_path is null and media_path is null and media_kind is null))
);
-- Existing RLS/grants and owner-folder Storage policies continue to apply.
