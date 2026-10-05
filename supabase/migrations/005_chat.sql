-- ============================================================
-- 005_chat.sql
--  · chat_messages (per space + user — separate history)
--  · suggested_prompts_cache (per space, short TTL)
--  · activity_logs (per user + space)
-- ============================================================

create table if not exists public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null references public.study_spaces(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        text not null check (role in ('user','assistant','system')),
  content     text not null,
  tokens_est  int not null default 0 check (tokens_est >= 0),
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

alter table public.chat_messages enable row level security;

-- User sees only their own messages. Owner of space can see all chat from collabs for moderation fallback.
create policy "chat_messages_self_select" on public.chat_messages
  for select using (
    auth.uid() = user_id
    or exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  );

create policy "chat_messages_self_insert" on public.chat_messages
  for insert with check (auth.uid() = user_id);

create policy "chat_messages_self_delete" on public.chat_messages
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- suggested_prompts_cache (cached generated 4 prompts per space + user)
-- ------------------------------------------------------------
create table if not exists public.suggested_prompts_cache (
  id           uuid primary key default gen_random_uuid(),
  space_id     uuid not null references public.study_spaces(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  prompts      jsonb not null default '[]'::jsonb,
  generated_by text not null default 'rule',
  expires_at   timestamptz not null default (now() + interval '1 hour'),
  created_at   timestamptz not null default now(),
  unique (space_id, user_id)
);

alter table public.suggested_prompts_cache enable row level security;

create policy "suggested_self" on public.suggested_prompts_cache
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- activity_logs (append-only log of everything)
-- ------------------------------------------------------------
create table if not exists public.activity_logs (
  id                uuid primary key default gen_random_uuid(),
  space_id          uuid references public.study_spaces(id) on delete set null,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  event_type        text not null check (
    event_type in (
      'space_visit','space_created','space_shared','space_deleted',
      'file_upload','file_processed','file_failed',
      'summary_generated','summary_regenerated',
      'flashcards_generated','flashcards_regenerated','flashcard_mastered','flashcard_unmastered',
      'quiz_created','quiz_started','quiz_submitted','quiz_deleted',
      'weak_areas_refreshed',
      'chat_message_sent','chat_history_cleared'
    )
  ),
  minutes_estimate  int not null default 0 check (minutes_estimate >= 0),
  meta              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

alter table public.activity_logs enable row level security;

-- Append-only self reads. Owner of space can read space_id logs for their spaces.
create policy "activity_logs_self_select" on public.activity_logs
  for select using (
    auth.uid() = user_id
    or (space_id is not null and exists (
         select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid()
       ))
  );

create policy "activity_logs_self_insert" on public.activity_logs
  for insert with check (auth.uid() = user_id);

-- No update or delete policies → rows are immutable once written.
