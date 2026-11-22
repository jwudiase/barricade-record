-- Barricade 기록 대국: Supabase tables
-- games : one row per game (written when the game starts)
-- moves : one row per ply (my moves and AI moves), all factor values from MY (the human player's) viewpoint
-- Security: anyone with the page can READ and ADD rows; nobody can change or delete rows through the API.

create table if not exists public.games (
  id           uuid primary key,
  created_at   timestamptz not null default now(),
  player       text not null check (char_length(player) between 1 and 40),
  device       text check (char_length(device) <= 20),
  my_side      smallint not null check (my_side in (0, 1)),          -- 0 = 선공(P0), 1 = 후공(P1)
  engine       text not null default 'alphabeta' check (char_length(engine) <= 20),
  start_level  smallint,                                               -- AI 강도(탐색 깊이) at game start
  app_version  text check (char_length(app_version) <= 20),
  user_agent   text check (char_length(user_agent) <= 400)
);

create table if not exists public.moves (
  id           bigint generated always as identity primary key,
  game_id      uuid not null references public.games(id) on delete cascade,
  ply          smallint not null check (ply between 1 and 400),      -- 수 번호 (1부터)
  mover        text not null check (mover in ('나', 'AI')),
  notation     text not null check (char_length(notation) <= 4),     -- e2, d4h, d4v
  action       smallint not null check (action between 0 and 242),
  action_type  text not null check (action_type in ('이동', '공격 벽', '수비 벽', '기타 벽')),
  phase        text not null check (phase in ('초반', '중반', '종반', '후반')),   -- '종반' = older app versions
  ai_level     smallint,                                               -- AI 강도 setting in effect
  -- values before the move, my viewpoint
  b_d_me double precision, b_d_op double precision, b_w_me double precision, b_w_op double precision,
  b_threat2 double precision, b_opp2 double precision, b_adv double precision, b_detour double precision,
  b_share double precision, b_vuln double precision, b_attack double precision, b_width double precision,
  b_center double precision, b_threat1 double precision, b_opp1 double precision,
  -- change made by the move (after - before), my viewpoint
  c_d_me double precision, c_d_op double precision, c_w_me double precision, c_w_op double precision,
  c_threat2 double precision, c_opp2 double precision, c_adv double precision, c_detour double precision,
  c_share double precision, c_vuln double precision, c_attack double precision, c_width double precision,
  c_center double precision, c_threat1 double precision, c_opp1 double precision,
  -- AI search info (AI moves), scores converted to my viewpoint (+ = good for me), centi-steps
  ai_score     integer,
  ai_depth     smallint,
  ai_nodes     integer,
  think_ms     integer,                                                -- time the mover took
  -- AI recommendation for my moves
  rec_notation text check (char_length(rec_notation) <= 4),
  rec_match    boolean,
  rec_score    integer,                                                -- AI eval of my position with its best move
  after_score  integer,                                                -- AI eval of my actual move, same depth as rec_score
  eval_loss    integer,                                                -- rec_score - after_score
  game_over    boolean not null default false,
  winner       text check (winner in ('나', 'AI')),
  created_at   timestamptz not null default now(),
  unique (game_id, ply)
);
create index if not exists moves_game_idx on public.moves (game_id);

alter table public.games enable row level security;
alter table public.moves enable row level security;

drop policy if exists "games read"   on public.games;
drop policy if exists "games insert" on public.games;
drop policy if exists "moves read"   on public.moves;
drop policy if exists "moves insert" on public.moves;
create policy "games read"   on public.games for select to anon, authenticated using (true);
create policy "games insert" on public.games for insert to anon, authenticated with check (true);
create policy "moves read"   on public.moves for select to anon, authenticated using (true);
create policy "moves insert" on public.moves for insert to anon, authenticated with check (true);

grant select, insert on public.games to anon, authenticated;
grant select, insert on public.moves to anon, authenticated;
revoke update, delete, truncate on public.games from anon, authenticated;
revoke update, delete, truncate on public.moves from anon, authenticated;

-- v1.1 (2026-11-22): new phase rule (walls used: 0-5 초반, 6-13 중반, 14+ or one side 0 → 후반)
-- alter table public.moves drop constraint if exists moves_phase_check;
-- alter table public.moves add constraint moves_phase_check check (phase in ('초반', '중반', '종반', '후반'));
