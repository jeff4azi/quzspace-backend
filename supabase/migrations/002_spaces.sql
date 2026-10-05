-- ============================================================
-- 002_spaces.sql
--  · study_spaces
--  · space_collaborators (owner + collaborators)
--  · share_codes (random base62 8-char codes for public links)
--  · space_ai_generation_flags (never_generated / cached timestamps)
--  · view: user_space_roles — unified (owner | collaborator) → used in RLS policies downstream
-- ============================================================

-- ------------------------------------------------------------
-- study_spaces
-- ------------------------------------------------------------
create table if not exists public.study_spaces (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  subject            text not null default 'General',
  description        text null,
  accent_style       text not null default 'earth' check (accent_style in ('earth','ocean','sunset','forest','lavender')),
  owner_id           uuid not null references public.profiles(id) on delete cascade,
  share_code         text null,
  files_visible      boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.study_spaces enable row level security;

create policy "spaces_select_owner" on public.study_spaces
  for select using (auth.uid() = owner_id);

create policy "spaces_insert_owner" on public.study_spaces
  for insert with check (auth.uid() = owner_id);

create policy "spaces_update_owner" on public.study_spaces
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create policy "spaces_delete_owner" on public.study_spaces
  for delete using (auth.uid() = owner_id);

-- Public share link viewers (no auth context needed for API but RLS still applies on service-role-free queries)
create policy "spaces_select_shared_public" on public.study_spaces
  for select using (share_code is not null);

drop trigger if exists trg_study_spaces_updated_at on public.study_spaces;
create trigger trg_study_spaces_updated_at
before update on public.study_spaces
for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- space_collaborators
-- ------------------------------------------------------------
create table if not exists public.space_collaborators (
  space_id     uuid not null references public.study_spaces(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  role         text not null default 'collaborator' check (role in ('collaborator','viewer')),
  joined_at    timestamptz not null default now(),
  invited_by   uuid null references public.profiles(id) on delete set null,
  primary key (space_id, user_id)
);

alter table public.space_collaborators enable row level security;

-- Owners see + manage collaborators for their spaces.
create policy "sc_owner_all" on public.space_collaborators
  for all using (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  );

-- A user can see their own collaborator rows.
create policy "sc_self_select" on public.space_collaborators
  for select using (auth.uid() = user_id);

-- Collaborators can see the space metadata, not edit.
create policy "spaces_select_collaborator" on public.study_spaces
  for select using (
    exists (
      select 1 from public.space_collaborators sc
      where sc.space_id = study_spaces.id and sc.user_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- share_codes
-- ------------------------------------------------------------
create table if not exists public.share_codes (
  id              uuid primary key default gen_random_uuid(),
  space_id        uuid not null unique references public.study_spaces(id) on delete cascade,
  code            text not null unique,
  files_visible   boolean not null default true,
  created_by      uuid not null references public.profiles(id) on delete cascade,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz null,
  views_count     int not null default 0
);

alter table public.share_codes enable row level security;

create policy "share_owner_all" on public.share_codes
  for all using (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  );

-- share_code codes are public resolveable; select-only open reads (used on /s/:code handler)
create policy "share_code_public_lookup" on public.share_codes
  for select using (true);

-- ------------------------------------------------------------
-- space_ai_generation_flags
-- ------------------------------------------------------------
create table if not exists public.space_ai_generation_flags (
  space_id                     uuid primary key references public.study_spaces(id) on delete cascade,
  flashcards_generated_at      timestamptz null,
  quizzes_generated_count      int not null default 0,
  weak_areas_last_cached_at    timestamptz null,
  last_summary_requested_at    timestamptz null,
  last_chunking_run_at         timestamptz null,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

alter table public.space_ai_generation_flags enable row level security;

create policy "aiflags_owner_collab" on public.space_ai_generation_flags
  for select using (
    auth.uid() in (
      select s.owner_id from public.study_spaces s where s.id = space_id
      union
      select sc.user_id from public.space_collaborators sc where sc.space_id = space_ai_generation_flags.space_id
    )
  );

create policy "aiflags_owner_write" on public.space_ai_generation_flags
  for insert with check (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  );

create policy "aiflags_owner_update" on public.space_ai_generation_flags
  for update using (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  );

drop trigger if exists trg_space_ai_flags_updated_at on public.space_ai_generation_flags;
create trigger trg_space_ai_flags_updated_at
before update on public.space_ai_generation_flags
for each row execute function public.set_updated_at();

-- Auto-seed flags row on space creation
create or replace function public.seed_space_flags()
returns trigger
language plpgsql
as $$
begin
  insert into public.space_ai_generation_flags (space_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists trg_space_seed_flags on public.study_spaces;
create trigger trg_space_seed_flags
after insert on public.study_spaces
for each row execute function public.seed_space_flags();

-- ------------------------------------------------------------
-- unified view: user_space_roles(space_id, user_id, role)
--   role ∈ {owner, collaborator, viewer}
-- ------------------------------------------------------------
create or replace view public.user_space_roles with (security_invoker = on) as
  select s.id as space_id, s.owner_id as user_id, 'owner'::text as role
  from public.study_spaces s
  union all
  select sc.space_id, sc.user_id, sc.role
  from public.space_collaborators sc;
