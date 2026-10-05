-- ============================================================
-- 003_files.sql
--  · files table (storage + extraction metadata)
--  · RLS: owner/collabs SELECT, owner UPDATE/DELETE
--  · Triggers for updated_at
-- ============================================================

create table if not exists public.files (
  id                  uuid primary key default gen_random_uuid(),
  space_id            uuid not null references public.study_spaces(id) on delete cascade,
  uploader_id         uuid not null references public.profiles(id) on delete cascade,
  source_kind         text not null default 'file' check (source_kind in ('file','pasted_text')),

  display_name        text not null,
  file_extension      text null,
  mime_type           text not null,
  size_bytes          bigint not null default 0 check (size_bytes >= 0),
  storage_object_path text null,
  storage_bucket      text null,
  storage_uploaded_at timestamptz null,

  status              text not null default 'uploading' check (status in ('uploading','extracting','processed','failed')),
  error_message       text null,

  extracted_text      text null,
  text_truncated      boolean not null default false,
  char_count          int not null default 0 check (char_count >= 0),
  page_count          int null check (page_count is null or page_count >= 0),
  needs_ocr           boolean not null default false,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.files enable row level security;

-- Owners + collaborators can see files (if the space has files_visible=true for public)
create policy "files_owner_all" on public.files
  for all using (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  );

create policy "files_collab_select_insert" on public.files
  for select using (
    exists (select 1 from public.space_collaborators sc where sc.space_id = files.space_id and sc.user_id = auth.uid())
  );

-- Public share viewers: only if share_code exists AND files_visible=true
create policy "files_shared_view_select" on public.files
  for select using (
    exists (
      select 1
      from public.study_spaces s
      where s.id = files.space_id
        and s.share_code is not null
        and s.files_visible = true
    )
  );

drop trigger if exists trg_files_updated_at on public.files;
create trigger trg_files_updated_at
before update on public.files
for each row execute function public.set_updated_at();
