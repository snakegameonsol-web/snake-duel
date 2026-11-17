-- Account-owned match history. Results are inserted only by the match server.
create table if not exists public.match_history (
  match_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  opponent_name text not null default 'Guest opponent' check (char_length(opponent_name) <= 20),
  result text not null check (result in ('VICTORY', 'DEFEAT', 'DRAW')),
  your_score integer not null default 0 check (your_score >= 0),
  opponent_score integer not null default 0 check (opponent_score >= 0),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  reason text not null default 'normal',
  created_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

alter table public.match_history enable row level security;
revoke all on table public.match_history from anon, authenticated;
grant select on table public.match_history to authenticated;
grant all on table public.match_history to service_role;

drop policy if exists "Players can read their own match history" on public.match_history;
create policy "Players can read their own match history"
on public.match_history
for select
to authenticated
using ((select auth.uid()) = user_id);
