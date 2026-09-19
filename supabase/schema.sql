-- Protein Plate database schema.
-- Run this once in Supabase: SQL Editor > New query > paste > Run.

-- Each user's daily protein goal
create table public.profiles (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  target     int  not null default 60 check (target between 10 and 300),
  updated_at timestamptz not null default now()
);

-- One row per logged meal. items is a JSON array like
-- [{"name":"Egg","protein":6,"qty":2}, {"name":"Chicken","unit":"g","protein":0.27,"qty":150}]
create table public.meals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  eaten_on   date not null,
  created_at timestamptz not null default now(),
  items      jsonb not null check (jsonb_typeof(items) = 'array')
);
create index meals_user_day on public.meals (user_id, eaten_on);

-- How many AI photo checks each user has used per day (for the daily cap)
create table public.check_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);

-- Row-level security: every user can only ever see and change their own rows.
alter table public.profiles    enable row level security;
alter table public.meals       enable row level security;
alter table public.check_usage enable row level security;

create policy "own profile" on public.profiles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own meals" on public.meals
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Users can read their usage but not change it. Only claim_check() writes here.
create policy "read own usage" on public.check_usage
  for select using (user_id = auth.uid());

-- Atomically uses up one photo check for today (UTC day).
-- Returns the new count, or null when the user has hit p_limit.
create or replace function public.claim_check(p_limit int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  insert into check_usage (user_id, day, count)
  values (auth.uid(), current_date, 1)
  on conflict (user_id, day) do update
    set count = check_usage.count + 1
    where check_usage.count < p_limit
  returning count into v_count;
  return v_count;
end;
$$;

revoke all on function public.claim_check(int) from public, anon;
grant execute on function public.claim_check(int) to authenticated;
