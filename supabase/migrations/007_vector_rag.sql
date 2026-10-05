-- ============================================================
-- 007_vector_rag.sql — AI Integration v2 Semantic RAG
--  · pgvector extension enable
--  · space_content_chunks (800-char chunks, 150 overlap, 1536-dim
--    text-embedding-3-small embeddings, HNSW with m=16 ef=64)
--  · embedding_provider_cache (dedup across spaces by content hash)
--  · enforce_4k_chunks_per_space() trigger (hard cap at 4,000)
--  · RLS policies
-- ============================================================

create extension if not exists vector with schema public;

-- ------------------------------------------------------------
-- space_content_chunks
-- ------------------------------------------------------------
create table if not exists public.space_content_chunks (
  id                uuid primary key default gen_random_uuid(),
  space_id          uuid not null references public.study_spaces(id) on delete cascade,
  file_id           uuid null references public.files(id) on delete set null,
  source_kind       text not null check (source_kind in ('pasted_text','file','summary_snippet','user_note')),
  chunk_index       int not null,
  section_heading   text null,
  page_number       int null check (page_number is null or page_number >= 0),
  text              text not null,
  char_count        int not null check (char_count >= 0),
  token_count       int not null check (token_count >= 0),
  embedding         vector(1536) not null,
  embedding_model   text not null default 'text-embedding-3-small',
  content_sha256    text null,
  created_at        timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Enforce 4,000-chunk hard cap per space
-- ------------------------------------------------------------
create or replace function public.enforce_chunk_cap_per_space()
returns trigger
language plpgsql
as $$
declare
  v_count int;
  v_oldest record;
  v_overflow int;
begin
  select count(*) into strict v_count
  from public.space_content_chunks scc
  where scc.space_id = new.space_id;

  if v_count > 4000 then
    v_overflow := v_count - 4000;
    for v_oldest in
      select id from public.space_content_chunks scc
      where scc.space_id = new.space_id
      order by scc.created_at asc, scc.chunk_index asc
      limit v_overflow
    loop
      delete from public.space_content_chunks where id = v_oldest.id;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_4k_chunks on public.space_content_chunks;
create trigger trg_enforce_4k_chunks
after insert on public.space_content_chunks
for each row execute function public.enforce_chunk_cap_per_space();

-- ------------------------------------------------------------
-- HNSW + coverage indexes
-- ------------------------------------------------------------
create index if not exists scc_space_created on public.space_content_chunks (space_id, created_at);
create index if not exists scc_file_pos on public.space_content_chunks (file_id, chunk_index);
create index if not exists scc_sha on public.space_content_chunks (content_sha256) where content_sha256 is not null;

create index if not exists scc_hnsw on public.space_content_chunks
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.space_content_chunks enable row level security;

create policy "scc_owner_collab_select" on public.space_content_chunks
  for select using (
    exists (
      select 1 from public.user_space_roles usr
      where usr.space_id = space_content_chunks.space_id
        and usr.user_id = auth.uid()
        and usr.role in ('owner','collaborator')
    )
  );

-- No direct write policies; only backend service role inserts/deletes.

-- ------------------------------------------------------------
-- embedding_provider_cache (dedup identical text across spaces)
-- ------------------------------------------------------------
create table if not exists public.embedding_provider_cache (
  id              uuid primary key default gen_random_uuid(),
  content_sha256  text not null unique,
  embedding       vector(1536) not null,
  embedding_model text not null,
  token_count     int not null default 0 check (token_count >= 0),
  hit_count       int not null default 1 check (hit_count >= 1),
  last_hit_at     timestamptz null,
  created_at      timestamptz not null default now()
);

alter table public.embedding_provider_cache enable row level security;
-- No public read/write; backend service role only.
