-- ============================================================
-- 006_indexes.sql
--  · Foreign-key lookup indexes (Postgres does NOT create these
--    automatically for FKs)
--  · (space_id, created_at desc) for list-queries on tables
--    per TR (rule): files, summaries, flashcards, quizzes, quiz_attempts
--  · Extra domain-specific coverage indexes
-- ============================================================

-- ============================================================
-- 1. Foreign key lookup indexes (baseline)
-- ============================================================

-- T2/T3 profiles
create index if not exists idx_profiles_role on public.profiles(role);

-- T2 spaces
create index if not exists idx_study_spaces_owner_id on public.study_spaces(owner_id);
create index if not exists idx_study_spaces_share_code on public.study_spaces(share_code) where share_code is not null;
create index if not exists idx_study_spaces_owner_created on public.study_spaces(owner_id, created_at desc);

create index if not exists idx_space_collaborators_user on public.space_collaborators(user_id);
create index if not exists idx_space_collaborators_space on public.space_collaborators(space_id);

create index if not exists idx_share_codes_space on public.share_codes(space_id);
create index if not exists idx_share_codes_code on public.share_codes(code);
create index if not exists idx_share_codes_expires on public.share_codes(expires_at) where expires_at is not null;

-- T3 files
create index if not exists idx_files_uploader on public.files(uploader_id);

-- T4 ai
create index if not exists idx_summaries_space on public.summaries(space_id);
create index if not exists idx_summaries_generated_by on public.summaries(generated_by);

create index if not exists idx_flashcards_space on public.flashcards(space_id);
create index if not exists idx_flashcard_mastery_user on public.flashcard_mastery(user_id);
create index if not exists idx_flashcard_mastery_mastered on public.flashcard_mastery(user_id, mastered);

create index if not exists idx_quizzes_space on public.quizzes(space_id);
create index if not exists idx_quizzes_created_by on public.quizzes(created_by);
create index if not exists idx_quizzes_difficulty on public.quizzes(difficulty);

create index if not exists idx_quiz_questions_quiz on public.quiz_questions(quiz_id);

create index if not exists idx_quiz_attempts_quiz on public.quiz_attempts(quiz_id);
create index if not exists idx_quiz_attempts_user on public.quiz_attempts(user_id);
create index if not exists idx_quiz_attempts_quiz_user_best on public.quiz_attempts(quiz_id, user_id, score_percent desc);

create index if not exists idx_quiz_answers_attempt on public.quiz_answers(attempt_id);
create index if not exists idx_quiz_answers_question on public.quiz_answers(question_id);
create index if not exists idx_quiz_answers_correct on public.quiz_answers(question_id, is_correct);

create index if not exists idx_weak_areas_user on public.weak_areas(user_id);
create index if not exists idx_weak_areas_expires on public.weak_areas(expires_at);

-- T5 chat + activity
create index if not exists idx_chat_messages_user on public.chat_messages(user_id);
create index if not exists idx_suggested_prompts_user on public.suggested_prompts_cache(user_id);
create index if not exists idx_suggested_prompts_expires on public.suggested_prompts_cache(expires_at);

create index if not exists idx_activity_logs_user on public.activity_logs(user_id);
create index if not exists idx_activity_logs_event_type on public.activity_logs(event_type);
create index if not exists idx_activity_logs_space_event on public.activity_logs(space_id, event_type) where space_id is not null;

-- ============================================================
-- 2. (space_id, created_at desc) list indexes — T3 TR (rule)
-- ============================================================

create index if not exists idx_files_list
  on public.files(space_id, created_at desc);

create index if not exists idx_summaries_list
  on public.summaries(space_id, created_at desc);

create index if not exists idx_flashcards_list
  on public.flashcards(space_id, created_at desc);

create index if not exists idx_quizzes_list
  on public.quizzes(space_id, created_at desc);

create index if not exists idx_quiz_attempts_list
  on public.quiz_attempts(space_id, created_at desc);

create index if not exists idx_quiz_attempts_quiz_list
  on public.quiz_attempts(quiz_id, created_at desc);

create index if not exists idx_quiz_attempts_space_list
  on public.quizzes(space_id) include (id);

create index if not exists idx_chat_messages_list
  on public.chat_messages(space_id, user_id, created_at desc);

create index if not exists idx_activity_logs_space_user_day
  on public.activity_logs(user_id, space_id, created_at desc);

-- ============================================================
-- 3. Extra: gin indexes on JSONB for dashboard / weak-areas queries
-- ============================================================

create index if not exists idx_quizzes_selected_topics_gin
  on public.quizzes using gin(selected_topics jsonb_ops);

create index if not exists idx_summaries_data_gin
  on public.summaries using gin(data jsonb_ops);

-- ============================================================
-- 4. user_space_roles quick check (already a view, this covers base tables)
-- ============================================================

create index if not exists idx_us_roles_lookup on public.space_collaborators(space_id, user_id, role);
