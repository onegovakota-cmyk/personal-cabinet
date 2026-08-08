-- Личный кабинет: финансы, долги, привычки и задачи
-- Можно запускать повторно: таблицы и политики создаются/обновляются безопасно.

create extension if not exists pgcrypto;

create table if not exists public.pf_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  monthly_income_target numeric(14,2) not null default 110000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pf_debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  debt_type text not null default 'other',
  initial_balance numeric(14,2) not null default 0 check (initial_balance >= 0),
  current_balance numeric(14,2) not null default 0 check (current_balance >= 0),
  apr numeric(7,3) not null default 0 check (apr >= 0),
  min_payment numeric(14,2) not null default 0 check (min_payment >= 0),
  target_date date,
  priority integer not null default 5 check (priority between 1 and 20),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.pf_fixed_expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  monthly_amount numeric(14,2) not null default 0 check (monthly_amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.pf_incomes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  category text not null default 'Другое',
  received_on date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.pf_expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  category text not null default 'Другое',
  spent_on date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.pf_debt_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  debt_id uuid not null references public.pf_debts(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  paid_on date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.pf_habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.pf_habit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  habit_id uuid not null references public.pf_habits(id) on delete cascade,
  day date not null,
  completed boolean not null default true,
  created_at timestamptz not null default now(),
  unique (habit_id, day)
);

create table if not exists public.pf_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  category text not null check (category in ('work','tutoring','home')),
  task_date date not null default current_date,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.pf_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pf_settings_updated_at on public.pf_settings;
create trigger pf_settings_updated_at before update on public.pf_settings for each row execute function public.pf_set_updated_at();
drop trigger if exists pf_debts_updated_at on public.pf_debts;
create trigger pf_debts_updated_at before update on public.pf_debts for each row execute function public.pf_set_updated_at();
drop trigger if exists pf_fixed_expenses_updated_at on public.pf_fixed_expenses;
create trigger pf_fixed_expenses_updated_at before update on public.pf_fixed_expenses for each row execute function public.pf_set_updated_at();
drop trigger if exists pf_tasks_updated_at on public.pf_tasks;
create trigger pf_tasks_updated_at before update on public.pf_tasks for each row execute function public.pf_set_updated_at();

alter table public.pf_settings enable row level security;
alter table public.pf_debts enable row level security;
alter table public.pf_fixed_expenses enable row level security;
alter table public.pf_incomes enable row level security;
alter table public.pf_expenses enable row level security;
alter table public.pf_debt_payments enable row level security;
alter table public.pf_habits enable row level security;
alter table public.pf_habit_logs enable row level security;
alter table public.pf_tasks enable row level security;

-- Унифицированные политики: пользователь видит и изменяет только свои строки.
do $$
declare
  t text;
begin
  foreach t in array array['pf_settings','pf_debts','pf_fixed_expenses','pf_incomes','pf_expenses','pf_debt_payments','pf_habits','pf_habit_logs','pf_tasks']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);

    execute format('create policy %I on public.%I for select to authenticated using (auth.uid() = user_id)', t || '_select_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (auth.uid() = user_id)', t || '_insert_own', t);
    execute format('create policy %I on public.%I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t || '_update_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using (auth.uid() = user_id)', t || '_delete_own', t);
  end loop;
end $$;

-- Атомарно записывает платёж и уменьшает текущий остаток долга.
create or replace function public.pf_record_debt_payment(
  p_debt_id uuid,
  p_amount numeric,
  p_paid_on date,
  p_note text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_balance numeric;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be positive'; end if;

  select current_balance into v_balance
  from public.pf_debts
  where id = p_debt_id and user_id = v_user
  for update;

  if not found then raise exception 'Debt not found'; end if;

  insert into public.pf_debt_payments(user_id, debt_id, amount, paid_on, note)
  values (v_user, p_debt_id, p_amount, coalesce(p_paid_on, current_date), nullif(trim(p_note), ''));

  update public.pf_debts
  set current_balance = greatest(current_balance - p_amount, 0)
  where id = p_debt_id and user_id = v_user;
end;
$$;

grant execute on function public.pf_record_debt_payment(uuid, numeric, date, text) to authenticated;
