-- ============================================================
-- 004_ai.sql
--  · summaries
--  · flashcards + flashcard_mastery (per-user junction)
--  · quizzes + quiz_questions
--  · quiz_attempts + quiz_answers
--  · weak_areas
-- ============================================================

-- ------------------------------------------------------------
-- summaries (per-space, upsert on regen)
-- ------------------------------------------------------------
create table if not exists public.summaries (
  id                uuid primary key default gen_random_uuid(),
  space_id          uuid not null unique references public.study_spaces(id) on delete cascade,
  generated_by      uuid null references public.profiles(id) on delete set null,
  model_used        text null,
  provider          text not null default 'stub',
  input_token_est   int not null default 0 check (input_token_est >= 0),
  status            text not null default 'generating' check (status in ('generating','ready','failed')),
  error_message     text null,
  data              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.summaries enable row level security;

create policy "summaries_select_owner_or_collab" on public.summaries
  for select using (
    auth.uid() in (
      select s.owner_id from public.study_spaces s where s.id = space_id
      union
      select sc.user_id from public.space_collaborators sc where sc.space_id = summaries.space_id
    )
    or exists (
      select 1 from public.study_spaces s
      where s.id = summaries.space_id and s.share_code is not null
    )
  );

create policy "summaries_owner_write" on public.summaries
  for all using (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  );

drop trigger if exists trg_summaries_updated_at on public.summaries;
create trigger trg_summaries_updated_at
before update on public.summaries
for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- flashcards
-- ------------------------------------------------------------
create table if not exists public.flashcards (
  id           uuid primary key default gen_random_uuid(),
  space_id     uuid not null references public.study_spaces(id) on delete cascade,
  front        text not null,
  back         text not null,
  topic        text null,
  position     int not null default 0 check (position >= 0),
  difficulty   text null check (difficulty is null or difficulty in ('Easy','Medium','Hard')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.flashcards enable row level security;

create policy "flashcards_select_viewers" on public.flashcards
  for select using (
    auth.uid() in (
      select s.owner_id from public.study_spaces s where s.id = space_id
      union
      select sc.user_id from public.space_collaborators sc where sc.space_id = flashcards.space_id
    )
    or exists (
      select 1 from public.study_spaces s
      where s.id = flashcards.space_id and s.share_code is not null
    )
  );

create policy "flashcards_owner_write" on public.flashcards
  for all using (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  );

drop trigger if exists trg_flashcards_updated_at on public.flashcards;
create trigger trg_flashcards_updated_at
before update on public.flashcards
for each row execute function public.set_updated_at();

-- Per-user mastery junction (not JSONB; correctness per tasks.md rubric)
create table if not exists public.flashcard_mastery (
  flashcard_id      uuid not null references public.flashcards(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  mastered          boolean not null default false,
  last_reviewed_at  timestamptz null,
  review_count      int not null default 0 check (review_count >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (flashcard_id, user_id)
);

alter table public.flashcard_mastery enable row level security;

create policy "fc_mastery_self_all" on public.flashcard_mastery
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists trg_fc_mastery_updated_at on public.flashcard_mastery;
create trigger trg_fc_mastery_updated_at
before update on public.flashcard_mastery
for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- quizzes
-- ------------------------------------------------------------
create table if not exists public.quizzes (
  id               uuid primary key default gen_random_uuid(),
  space_id         uuid not null references public.study_spaces(id) on delete cascade,
  title            text not null,
  difficulty       text not null default 'Mixed' check (difficulty in ('Easy','Medium','Hard','Mixed')),
  question_count   int not null default 10 check (question_count between 1 and 50),
  selected_topics  jsonb not null default '[]'::jsonb,
  created_by       uuid not null references public.profiles(id) on delete cascade,
  model_used       text null,
  provider         text not null default 'stub',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.quizzes enable row level security;

create policy "quizzes_select_viewers" on public.quizzes
  for select using (
    auth.uid() in (
      select s.owner_id from public.study_spaces s where s.id = space_id
      union
      select sc.user_id from public.space_collaborators sc where sc.space_id = quizzes.space_id
    )
    or exists (
      select 1 from public.study_spaces s
      where s.id = quizzes.space_id and s.share_code is not null
    )
  );

create policy "quizzes_owner_cud" on public.quizzes
  for all using (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.study_spaces s where s.id = space_id and s.owner_id = auth.uid())
  );

drop trigger if exists trg_quizzes_updated_at on public.quizzes;
create trigger trg_quizzes_updated_at
before update on public.quizzes
for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- quiz_questions
-- ------------------------------------------------------------
create table if not exists public.quiz_questions (
  id                   uuid primary key default gen_random_uuid(),
  quiz_id              uuid not null references public.quizzes(id) on delete cascade,
  question_index       int not null check (question_index >= 0),
  question             text not null,
  options              jsonb not null default '[]'::jsonb,
  correct_answer_index int not null check (correct_answer_index >= 0),
  topic                text null,
  explanation          text null,
  created_at           timestamptz not null default now(),
  unique (quiz_id, question_index)
);

alter table public.quiz_questions enable row level security;

-- Owners see full question (with answer) always.
-- Collaborators/viewers see it via service-role quiz/take endpoint which strips answers.
create policy "qq_owner_all" on public.quiz_questions
  for all using (
    exists (
      select 1 from public.quizzes q
      join public.study_spaces s on s.id = q.space_id
      where q.id = quiz_id and s.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.quizzes q
      join public.study_spaces s on s.id = q.space_id
      where q.id = quiz_id and s.owner_id = auth.uid()
    )
  );

create policy "qq_viewers_select_question_only" on public.quiz_questions
  for select using (
    auth.uid() in (
      select s.owner_id from public.quizzes q
      join public.study_spaces s on s.id = q.space_id
      where q.id = quiz_id
      union
      select sc.user_id from public.quizzes q
      join public.space_collaborators sc on sc.space_id = q.space_id
      where q.id = quiz_questions.quiz_id
    )
    or exists (
      select 1 from public.quizzes q
      join public.study_spaces s on s.id = q.space_id
      where q.id = quiz_id and s.share_code is not null
    )
  );

-- ------------------------------------------------------------
-- quiz_attempts + quiz_answers
-- ------------------------------------------------------------
create table if not exists public.quiz_attempts (
  id              uuid primary key default gen_random_uuid(),
  space_id        uuid not null references public.study_spaces(id) on delete cascade,
  quiz_id         uuid not null references public.quizzes(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  attempt_number  int not null default 1 check (attempt_number >= 1),
  score_percent   numeric(5,2) not null default 0 check (score_percent between 0 and 100),
  correct_count   int not null default 0 check (correct_count >= 0),
  total_questions int not null check (total_questions >= 0),
  time_taken_sec  int not null default 0 check (time_taken_sec >= 0),
  started_at      timestamptz null,
  submitted_at    timestamptz null,
  created_at      timestamptz not null default now(),
  unique (quiz_id, user_id, attempt_number)
);

alter table public.quiz_attempts enable row level security;

create policy "qa_owner_self_viewers" on public.quiz_attempts
  for select using (
    auth.uid() = user_id
    or exists (
      select 1 from public.quizzes q
      join public.study_spaces s on s.id = q.space_id
      where q.id = quiz_id and s.owner_id = auth.uid()
    )
  );

create policy "qa_self_insert_update" on public.quiz_attempts
  for insert with check (auth.uid() = user_id);

create policy "qa_self_update" on public.quiz_attempts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.quiz_answers (
  id                  uuid primary key default gen_random_uuid(),
  attempt_id          uuid not null references public.quiz_attempts(id) on delete cascade,
  question_id         uuid not null references public.quiz_questions(id) on delete cascade,
  selected_index      int null check (selected_index is null or selected_index >= 0),
  is_correct          boolean not null default false,
  answered_at         timestamptz not null default now(),
  unique (attempt_id, question_id)
);

alter table public.quiz_answers enable row level security;

create policy "qans_self_select" on public.quiz_answers
  for select using (
    auth.uid() in (
      select a.user_id from public.quiz_attempts a where a.id = attempt_id
      union
      select s.owner_id
      from public.quiz_attempts a
      join public.quizzes q on q.id = a.quiz_id
      join public.study_spaces s on s.id = q.space_id
      where a.id = quiz_answers.attempt_id
    )
  );

create policy "qans_self_write" on public.quiz_answers
  for all using (
    exists (
      select 1 from public.quiz_attempts a where a.id = attempt_id and a.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.quiz_attempts a where a.id = attempt_id and a.user_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- weak_areas (cached result per space + user)
-- ------------------------------------------------------------
create table if not exists public.weak_areas (
  id             uuid primary key default gen_random_uuid(),
  space_id       uuid not null references public.study_spaces(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  status         text not null default 'computing' check (status in ('insufficient_data','computing','ready','failed')),
  data           jsonb not null default '[]'::jsonb,
  expires_at     timestamptz not null default (now() + interval '6 hours'),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (space_id, user_id)
);

alter table public.weak_areas enable row level security;

create policy "weak_areas_self" on public.weak_areas
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists trg_weak_areas_updated_at on public.weak_areas;
create trigger trg_weak_areas_updated_at
before update on public.weak_areas
for each row execute function public.set_updated_at();
