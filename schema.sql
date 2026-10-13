-- =====================================================================
-- Primo Barbershop — Supabase schema
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to read top to bottom: tables, security rules, functions, seed data.
--
-- Security model
--   * Customers are anonymous. They can NEVER read the bookings table.
--     They only call the functions below (create_booking, get_busy, ...),
--     which validate everything on the server.
--   * The owner signs in with Supabase Auth (email + password). Only users
--     listed in the "owners" table can read/write bookings, staff, etc.
-- =====================================================================

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- Owner allow-list
-- ---------------------------------------------------------------------
create table if not exists public.owners (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.owners enable row level security;   -- no policies = nobody can read it through the API

create or replace function public.is_owner()
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.owners where user_id = auth.uid()); $$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists public.services (
  id           text primary key,                 -- short slug, e.g. 'fade'
  category     text not null,
  name         text not null,
  description  text,
  price        numeric(10,2) not null check (price >= 0),
  duration_min int not null check (duration_min between 5 and 480),
  active       boolean not null default true,
  sort_order   int not null default 0
);

create table if not exists public.shop_hours (
  dow        int primary key check (dow between 0 and 6),   -- 0 = Sunday
  open_hour  int check (open_hour between 0 and 23),        -- null = closed
  close_hour int check (close_hour between 1 and 24)
);

create table if not exists public.barbers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  role        text not null default 'Barber',
  tags        text[] not null default '{}',
  rating      numeric(2,1),
  commission  numeric(5,4) not null default 0.30 check (commission between 0 and 1),
  active      boolean not null default true,
  hours       jsonb not null default '{}'::jsonb,   -- {"1":[10,19],"2":[10,19]}  day-of-week -> [start hour, end hour]
  avatar      jsonb,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.bookings (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 6)),
  customer_name  text not null,
  phone          text not null,
  email          text,
  notes          text,
  service_id     text not null,
  service_name   text not null,
  price          numeric(10,2) not null,
  duration_min   int not null,
  barber_id      uuid references public.barbers(id) on delete set null,
  barber_name    text,
  booking_date   date not null,
  start_min      int not null check (start_min between 0 and 1439),   -- minutes after midnight, Manila time
  status         text not null default 'confirmed'
                 check (status in ('confirmed','completed','cancelled','no-show')),
  auto_no_show   boolean not null default false,
  commission_rate numeric(5,4),
  source         text not null default 'online',     -- 'online' or 'manual'
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  -- the database itself refuses double-booking a barber
  constraint bookings_no_overlap exclude using gist (
    barber_id with =,
    booking_date with =,
    (int4range(start_min, start_min + duration_min)) with &&
  ) where (status in ('confirmed','completed'))
);
create index if not exists bookings_date_idx  on public.bookings (booking_date);
create index if not exists bookings_phone_idx on public.bookings (phone);

create table if not exists public.queue (
  id         uuid primary key default gen_random_uuid(),
  queue_date date not null default ((now() at time zone 'Asia/Manila')::date),
  queue_no   int  not null,
  name       text not null,
  phone      text not null,
  status     text not null default 'waiting' check (status in ('waiting','serving','done','removed')),
  created_at timestamptz not null default now(),
  unique (queue_date, queue_no)
);

create table if not exists public.inventory (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  stock     int not null default 0,
  min_stock int not null default 0
);

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
alter table public.services   enable row level security;
alter table public.shop_hours enable row level security;
alter table public.barbers    enable row level security;
alter table public.bookings   enable row level security;
alter table public.queue      enable row level security;
alter table public.inventory  enable row level security;

drop policy if exists "services read"   on public.services;
drop policy if exists "services owner"  on public.services;
drop policy if exists "hours read"      on public.shop_hours;
drop policy if exists "hours owner"     on public.shop_hours;
drop policy if exists "barbers owner"   on public.barbers;
drop policy if exists "bookings owner"  on public.bookings;
drop policy if exists "queue owner"     on public.queue;
drop policy if exists "inventory owner" on public.inventory;

create policy "services read"   on public.services   for select using (true);
create policy "services owner"  on public.services   for all using (public.is_owner()) with check (public.is_owner());
create policy "hours read"      on public.shop_hours for select using (true);
create policy "hours owner"     on public.shop_hours for all using (public.is_owner()) with check (public.is_owner());
-- barbers hold commission rates, so the public cannot read this table directly (see public_barbers() below)
create policy "barbers owner"   on public.barbers    for all using (public.is_owner()) with check (public.is_owner());
create policy "bookings owner"  on public.bookings   for all using (public.is_owner()) with check (public.is_owner());
create policy "queue owner"     on public.queue      for all using (public.is_owner()) with check (public.is_owner());
create policy "inventory owner" on public.inventory  for all using (public.is_owner()) with check (public.is_owner());

-- ---------------------------------------------------------------------
-- Trigger: lock in the commission rate when a booking is completed
-- ---------------------------------------------------------------------
create or replace function public.bookings_status_trigger()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    new.commission_rate := coalesce((select commission from public.barbers where id = new.barber_id), new.commission_rate, 0);
    new.completed_at := now();
  end if;
  return new;
end $$;

drop trigger if exists bookings_status on public.bookings;
create trigger bookings_status before update on public.bookings
  for each row execute function public.bookings_status_trigger();

-- ---------------------------------------------------------------------
-- Public functions (what customers can do). All validation lives here.
-- ---------------------------------------------------------------------

-- Barbers without commission rates.
create or replace function public.public_barbers()
returns table (id uuid, name text, role text, tags text[], rating numeric, hours jsonb, avatar jsonb)
language sql stable security definer set search_path = public
as $$
  select b.id, b.name, b.role, b.tags, b.rating, b.hours, b.avatar
  from public.barbers b where b.active order by b.sort_order, b.created_at;
$$;

-- Which time ranges are taken on a date. No customer details are returned.
create or replace function public.get_busy(p_date date)
returns table (barber_id uuid, start_min int, duration_min int)
language sql stable security definer set search_path = public
as $$
  select k.barber_id, k.start_min, k.duration_min
  from public.bookings k
  where k.booking_date = p_date and k.status in ('confirmed','completed') and k.barber_id is not null;
$$;

-- How many people are waiting in today's walk-in queue.
create or replace function public.public_status()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('waiting', (
    select count(*) from public.queue
    where queue_date = (now() at time zone 'Asia/Manila')::date and status = 'waiting'));
$$;

-- Create a booking. The server re-checks hours, barber, service price and double-booking.
create or replace function public.create_booking(
  p_name text, p_phone text, p_email text, p_notes text,
  p_service_id text, p_barber uuid, p_date date, p_start int
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_svc   public.services%rowtype;
  v_bar   public.barbers%rowtype;
  v_shop  public.shop_hours%rowtype;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[[:space:]().-]', '', 'g');
  v_now   timestamp := (now() at time zone 'Asia/Manila');
  v_dow   int;
  v_hours jsonb;
  v_open  int;
  v_close int;
  v_id    uuid;
  v_code  text;
begin
  if p_date is null or p_start is null then return jsonb_build_object('ok', false, 'error', 'invalid_date'); end if;
  v_dow := extract(dow from p_date)::int;

  if coalesce(trim(p_name), '') = '' or length(p_name) > 80 then
    return jsonb_build_object('ok', false, 'error', 'invalid_name'); end if;
  if v_phone !~ '^\+?[0-9]{7,15}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_phone'); end if;
  if coalesce(p_email, '') <> '' and p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_email'); end if;
  if length(coalesce(p_notes, '')) > 300 then
    return jsonb_build_object('ok', false, 'error', 'invalid_notes'); end if;

  select * into v_svc from public.services where id = p_service_id and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'invalid_service'); end if;

  select * into v_bar from public.barbers where id = p_barber and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'invalid_barber'); end if;

  if p_date < v_now::date or p_date > v_now::date + 60 then
    return jsonb_build_object('ok', false, 'error', 'invalid_date'); end if;

  select * into v_shop from public.shop_hours where dow = v_dow;
  if not found or v_shop.open_hour is null then
    return jsonb_build_object('ok', false, 'error', 'closed'); end if;

  v_hours := v_bar.hours -> (v_dow::text);
  if v_hours is null or jsonb_typeof(v_hours) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'barber_off'); end if;

  v_open  := greatest(v_shop.open_hour,  (v_hours ->> 0)::int);
  v_close := least(v_shop.close_hour,    (v_hours ->> 1)::int);
  if p_start < v_open * 60 or p_start + v_svc.duration_min > v_close * 60 then
    return jsonb_build_object('ok', false, 'error', 'outside_hours'); end if;

  if p_date = v_now::date and p_start <= extract(hour from v_now)::int * 60 + extract(minute from v_now)::int then
    return jsonb_build_object('ok', false, 'error', 'in_past'); end if;

  -- simple abuse limit: at most 3 upcoming confirmed bookings per phone number
  if (select count(*) from public.bookings
      where phone = v_phone and status = 'confirmed' and booking_date >= v_now::date) >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many'); end if;

  begin
    insert into public.bookings
      (customer_name, phone, email, notes, service_id, service_name, price, duration_min,
       barber_id, barber_name, booking_date, start_min)
    values
      (trim(p_name), v_phone, nullif(trim(coalesce(p_email, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
       v_svc.id, v_svc.name, v_svc.price, v_svc.duration_min,
       v_bar.id, v_bar.name, p_date, p_start)
    returning id, code into v_id, v_code;
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'error', 'slot_taken');
  end;

  return jsonb_build_object('ok', true, 'code', v_code, 'service_name', v_svc.name, 'barber_name', v_bar.name,
                            'price', v_svc.price, 'duration_min', v_svc.duration_min,
                            'date', p_date, 'start_min', p_start);
end $$;

-- Look up one booking (needs BOTH the booking code and the phone number).
create or replace function public.my_booking(p_code text, p_phone text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  r public.bookings%rowtype;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[[:space:]().-]', '', 'g');
begin
  select * into r from public.bookings where code = upper(trim(coalesce(p_code, ''))) and phone = v_phone;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'code', r.code, 'status', r.status, 'service_name', r.service_name,
                            'barber_name', r.barber_name, 'date', r.booking_date, 'start_min', r.start_min,
                            'price', r.price, 'duration_min', r.duration_min);
end $$;

-- Cancel a booking (needs code + phone, at least 2 hours before the appointment).
create or replace function public.cancel_booking(p_code text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r public.bookings%rowtype;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[[:space:]().-]', '', 'g');
begin
  select * into r from public.bookings
   where code = upper(trim(coalesce(p_code, ''))) and phone = v_phone for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if r.status <> 'confirmed' then return jsonb_build_object('ok', false, 'error', 'not_cancellable'); end if;
  if ((r.booking_date + make_interval(mins => r.start_min)) at time zone 'Asia/Manila') < now() + interval '2 hours' then
    return jsonb_build_object('ok', false, 'error', 'too_late'); end if;
  update public.bookings set status = 'cancelled' where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- Loyalty points = completed visits for that phone number.
create or replace function public.loyalty_points(p_phone text)
returns int
language sql stable security definer set search_path = public
as $$
  select count(*)::int from public.bookings
  where status = 'completed' and phone = regexp_replace(coalesce(p_phone, ''), '[[:space:]().-]', '', 'g');
$$;

-- Join today's walk-in queue.
create or replace function public.join_queue(p_name text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[[:space:]().-]', '', 'g');
  v_date  date := (now() at time zone 'Asia/Manila')::date;
  v_no    int;
  v_ahead int;
begin
  if coalesce(trim(p_name), '') = '' or length(p_name) > 80 then
    return jsonb_build_object('ok', false, 'error', 'invalid_name'); end if;
  if v_phone !~ '^\+?[0-9]{7,15}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_phone'); end if;
  if exists (select 1 from public.queue where queue_date = v_date and phone = v_phone and status = 'waiting') then
    return jsonb_build_object('ok', false, 'error', 'already_waiting'); end if;
  if (select count(*) from public.queue where queue_date = v_date and status = 'waiting') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'queue_full'); end if;

  for i in 1..5 loop
    select coalesce(max(queue_no), 0) + 1 into v_no from public.queue where queue_date = v_date;
    begin
      insert into public.queue (queue_date, queue_no, name, phone) values (v_date, v_no, trim(p_name), v_phone);
      exit;
    exception when unique_violation then
      if i = 5 then return jsonb_build_object('ok', false, 'error', 'try_again'); end if;
    end;
  end loop;

  select count(*) into v_ahead from public.queue where queue_date = v_date and status = 'waiting' and queue_no < v_no;
  return jsonb_build_object('ok', true, 'queue_no', v_no, 'ahead', v_ahead);
end $$;

-- Confirmed bookings still open 24 hours after their time become "no-show".
-- The owner dashboard calls this; you can also schedule it (see README).
create or replace function public.auto_expire_bookings()
returns int
language plpgsql security definer set search_path = public
as $$
declare v_n int;
begin
  update public.bookings
     set status = 'no-show', auto_no_show = true
   where status = 'confirmed'
     and ((booking_date + make_interval(mins => start_min)) at time zone 'Asia/Manila') <= now() - interval '24 hours';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Starter data (edit later in Table Editor or from the owner dashboard)
-- ---------------------------------------------------------------------
insert into public.shop_hours (dow, open_hour, close_hour) values
  (0, null, null), (1, 9, 20), (2, 9, 20), (3, 9, 20), (4, 9, 20), (5, 9, 20), (6, 9, 21)
on conflict (dow) do nothing;

insert into public.services (id, category, name, description, price, duration_min, sort_order) values
  ('cut',   'Haircuts', 'Signature Haircut',       'Consultation, cut, styling and a neck shave to finish.', 350, 30, 1),
  ('fade',  'Haircuts', 'Skin Fade',               'Razor-clean fade blended into any length on top.',       400, 45, 2),
  ('kids',  'Haircuts', 'Kids Cut (12 & under)',   'Same care, smaller chair time.',                         250, 25, 3),
  ('shave', 'Grooming', 'Hot Towel Shave',         'Straight razor, hot towels, pre- and post-shave oil.',   300, 30, 4),
  ('beard', 'Grooming', 'Beard Trim & Sculpt',     'Line-up and shape, tailored to your face and growth.',   200, 20, 5),
  ('combo', 'Combos',   'Cut + Shave Combo',       'Signature haircut paired with a hot towel shave.',       600, 60, 6),
  ('color', 'Color',    'Hair Color / Grey Blend', 'Natural-looking coverage or a subtle grey blend.',       500, 60, 7)
on conflict (id) do nothing;

insert into public.barbers (name, role, tags, rating, commission, hours, avatar, sort_order)
select * from (values
  ('Mark',  'Senior Barber', array['Skin fades','Tapers','Modern cuts'],  4.9::numeric, 0.30::numeric,
    '{"1":[10,19],"2":[10,19],"3":[10,19],"4":[10,19],"5":[10,19],"6":[10,19]}'::jsonb,
    '{"skin":"#c69168","hair":"#16120f","style":"fade","beard":true}'::jsonb, 1),
  ('Juan',  'Barber',        array['Classic cuts','Beard sculpting'],     4.8::numeric, 0.30::numeric,
    '{"1":[10,19],"2":[10,19],"4":[10,19],"5":[10,19],"6":[10,19]}'::jsonb,
    '{"skin":"#a8714a","hair":"#1b1511","style":"quiff","beard":false}'::jsonb, 2),
  ('Carlo', 'Barber',        array['Color','Grey blending'],              4.7::numeric, 0.30::numeric,
    '{"2":[12,20],"3":[12,20],"4":[12,20],"5":[12,20],"6":[10,19]}'::jsonb,
    '{"skin":"#d8a77f","hair":"#2a2018","style":"crop","beard":true}'::jsonb, 3)
) as v(name, role, tags, rating, commission, hours, avatar, sort_order)
where not exists (select 1 from public.barbers);

insert into public.inventory (name, stock, min_stock)
select * from (values ('Pomade', 8, 5), ('Shampoo', 3, 5), ('Hair Powder', 12, 5), ('Razor Blades (box)', 2, 3)) as v(name, stock, min_stock)
where not exists (select 1 from public.inventory);
