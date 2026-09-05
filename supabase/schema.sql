-- =====================================================================
--  GANESH UTSAV -- Society Event Management (cloud side)
--  Food plate ledger + contribution collection + expenses
--
--  Run ONCE in Supabase -> SQL Editor -> New query -> Run.
--  Safe to re-run: everything is IF NOT EXISTS / CREATE OR REPLACE.
--
--  ---------------------------------------------------------------
--  THE ONE RULE THAT MAKES THIS WHOLE SYSTEM WORK
--  ---------------------------------------------------------------
--  The three ledger tables -- servings, contributions, expenses --
--  are STRICTLY APPEND-ONLY. Rows are never UPDATEd, never DELETEd.
--  A correction is a NEW row with a negative amount pointing back at
--  the original via void_of_id.
--
--  Consequences, all of which we depend on:
--    * two phones writing at the same instant can never conflict
--    * any total is just SUM() -- it can never drift
--    * Odoo syncs with a plain `id > cursor` cursor and can never miss
--      or double-count a row, even after being switched off for days
--    * an offline retry cannot inflate a total, because client_uid is
--      unique and collapses duplicates server-side
--  ---------------------------------------------------------------
-- =====================================================================

create extension if not exists "pgcrypto";

-- =====================================================================
-- 1. SETTINGS  (single row, shared by app + Odoo)
-- =====================================================================
create table if not exists app_settings (
    id                    integer primary key default 1,
    event_name            text    not null default 'Ganesh Mahotsav',
    event_year            integer not null default 2026,
    receipt_prefix        text    not null default 'GU26',
    -- money
    contribution_default  numeric(12,2) not null default 500,   -- Rs.500 per house
    extra_plate_rate      numeric(12,2) not null default 30,    -- per plate beyond member_count
    currency_symbol       text    not null default '₹',
    allow_extra_plates    boolean not null default true,
    updated_at            timestamptz not null default now(),
    constraint app_settings_singleton check (id = 1)
);
insert into app_settings (id) values (1) on conflict (id) do nothing;

-- =====================================================================
-- 2. HOUSES  -- the society roster. The ONLY source of numbering.
--
--    Irregular numbering (A 1-10 / B 11-60 / C 1-57 / merged 65-66)
--    is expressed purely as DATA. There is no numbering logic in code,
--    so any exception you discover later is a data fix, not a release.
--
--    member_count         = registered plates per day this house asked for
--    contribution_expected= what this house owes (default Rs.500, editable)
-- =====================================================================
create table if not exists houses (
    id                    bigserial primary key,
    house_code            text    not null unique,      -- 'B-56'  (permanent id)
    wing_group            text    not null default 'AB',-- grid tab: 'AB' | 'C'
    number_label          text    not null,             -- text on the button: '56', '65-66'
    sort_order            integer not null default 0,
    family_name           text    not null default '',
    member_count          integer not null default 1,
    contribution_expected numeric(12,2) not null default 500,
    phone                 text    not null default '',
    notes                 text    not null default '',
    is_active             boolean not null default true,
    updated_at            timestamptz not null default now(),
    odoo_id               integer
);
create index if not exists houses_group_sort_idx on houses (wing_group, sort_order);
create index if not exists houses_updated_idx    on houses (updated_at);

-- =====================================================================
-- 3. EVENT DAYS -- the 7 days. event_date is the natural key.
-- =====================================================================
create table if not exists event_days (
    id           bigserial primary key,
    event_date   date    not null unique,
    day_no       integer not null,
    menu_label   text    not null default '',
    plate_rate   numeric(12,2),          -- price of ONE plate on this day
    window_start time,
    window_end   time,
    is_open      boolean not null default true,
    updated_at   timestamptz not null default now()
);

-- Migration for projects created before plate_rate existed. Each day has its
-- own price (a Full Dish is worth three Moong Pulaos), so a single flat extra
-- rate would mis-bill every chargeable plate. app_settings.extra_plate_rate
-- stays only as the fallback for a date that is not a listed event day.
alter table event_days add column if not exists plate_rate numeric(12,2);

-- =====================================================================
-- 4. PROFILES -- auth user -> role, name, and RECEIPT SERIES
--
--    receipt_series is this volunteer's personal receipt book letter.
--    Receipt numbers are issued on the phone as (series, next number),
--    which is why door-to-door collection works with no signal at all
--    and two volunteers can never issue the same receipt number.
-- =====================================================================
create table if not exists profiles (
    id             uuid primary key references auth.users (id) on delete cascade,
    display_name   text not null default '',
    role           text not null default 'volunteer',   -- 'admin' | 'volunteer'
    receipt_series text not null default '',            -- 'A', 'B', 'C' ...
    can_collect    boolean not null default true,
    can_expense    boolean not null default false,
    created_at     timestamptz not null default now(),
    constraint profiles_role_chk check (role in ('admin','volunteer'))
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into public.profiles (id, display_name, role, receipt_series)
    values (new.id,
            coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)),
            coalesce(new.raw_user_meta_data->>'role', 'volunteer'),
            coalesce(new.raw_user_meta_data->>'receipt_series', ''))
    on conflict (id) do nothing;
    return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
    for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- =====================================================================
-- 5. SERVINGS -- food plate ledger. APPEND-ONLY.
--
--    One tap of "+4" -> one row (qty 4).
--    A tap that crosses member_count -> TWO rows:
--        one with the covered part (is_extra = false)
--        one with the chargeable part (is_extra = true)
--    Undo -> a new row, negative qty, void_of_id = original.
-- =====================================================================
create table if not exists servings (
    id           bigserial primary key,
    action_id    uuid    not null default gen_random_uuid(),
    house_id     bigint  references houses (id) on delete restrict,
    event_date   date    not null,
    qty          integer not null,
    is_extra     boolean not null default false,
    is_guest     boolean not null default false,
    served_by    text    not null default '',
    device_label text    not null default '',
    void_of_id   bigint  references servings (id),
    served_at    timestamptz not null default now(),
    client_uid   text    unique,
    constraint servings_qty_nonzero check (qty <> 0),
    constraint servings_house_or_guest check (
        (is_guest and house_id is null) or (not is_guest and house_id is not null))
);
create index if not exists servings_date_idx  on servings (event_date);
create index if not exists servings_house_idx on servings (house_id, event_date);

-- =====================================================================
-- 6. CONTRIBUTIONS -- vargani / chanda / donations. APPEND-ONLY.
--
--    house_id NULL + donor_name filled = outside donor / sponsor.
--    Amount may be more or less than houses.contribution_expected --
--    the statement shows the difference, the app never blocks it.
-- =====================================================================
create table if not exists contributions (
    id             bigserial primary key,
    house_id       bigint  references houses (id) on delete restrict,
    donor_name     text    not null default '',   -- for non-house donors
    amount         numeric(12,2) not null,        -- negative = correction
    mode           text    not null default 'cash',
    receipt_series text    not null default '',
    receipt_no     integer,
    collected_by   text    not null default '',
    collected_by_uid uuid  references auth.users (id),
    notes          text    not null default '',
    void_of_id     bigint  references contributions (id),
    collected_at   timestamptz not null default now(),
    client_uid     text    unique,
    constraint contrib_amount_nonzero check (amount <> 0),
    constraint contrib_who_chk check (house_id is not null or donor_name <> '')
);

-- ---------------------------------------------------------------------
-- Money is collected for EIGHT separate things, not one lump sum:
--
--   * ganpati  -- the general donation. Any amount, no expectation.
--   * food     -- one line per event day. Fixed price per plate for that
--                 day, times the number of plates the house is paying for.
--
-- So "registered plates" is not a property of the house at all. It is
-- whatever that house has PAID FOR on that specific day. A house that
-- gave Rs.501 to ganpati and bought no food is registered for zero plates
-- on every day, and every plate it takes is chargeable.
--
-- One collection = one receipt number = several rows sharing a
-- collection_uid (a receipt has lines, like any receipt).
-- ---------------------------------------------------------------------
alter table contributions add column if not exists purpose        text;
alter table contributions add column if not exists event_date     date;
alter table contributions add column if not exists qty            integer;
alter table contributions add column if not exists collection_uid uuid;

update contributions set purpose = 'ganpati' where purpose is null;
alter table contributions alter column purpose set default 'ganpati';
alter table contributions alter column purpose set not null;

do $$ begin
    alter table contributions add constraint contrib_purpose_chk
        check (purpose in ('ganpati','food'));
exception when duplicate_object then null; end $$;

do $$ begin
    -- a food line must say which day and how many plates
    alter table contributions add constraint contrib_food_chk
        check (purpose <> 'food' or (event_date is not null and qty is not null));
exception when duplicate_object then null; end $$;

create index if not exists contrib_purpose_idx on contributions (purpose, event_date);
create index if not exists contrib_collection_idx on contributions (collection_uid);

-- One receipt now covers several lines, so the old
-- unique(receipt_series, receipt_no) no longer holds. Numbers are issued
-- per volunteer series on their own phone, which is what makes offline
-- collection collision-proof; duplicate protection for retries comes from
-- client_uid, which is still unique.
drop index if exists contrib_receipt_uk;
create index if not exists contrib_receipt_idx
    on contributions (receipt_series, receipt_no);

-- but within ONE collection a given purpose/day may appear only once
create unique index if not exists contrib_line_uk
    on contributions (collection_uid, purpose, coalesce(event_date, '1900-01-01'))
    where collection_uid is not null and void_of_id is null;

-- ---------------------------------------------------------------------
-- Receipt numbers are issued on the phone (max seen + 1) so that
-- collection works at a front door with no signal. That is collision-proof
-- only while one volunteer uses one device. Two devices signed in as the
-- same person each compute the same "next" number and hand the same
-- receipt to two different families.
--
-- A plain unique index cannot express this, because one receipt legitimately
-- has several rows -- a Ganpati line plus a line per day. So: reject a row
-- whose (series, number) already belongs to a DIFFERENT collection. The app
-- catches this, takes the next free number and retries, so the volunteer
-- never sees anything except the corrected number.
-- ---------------------------------------------------------------------
create or replace function public.contributions_receipt_guard()
returns trigger language plpgsql as $$
begin
    if new.receipt_no is null or new.void_of_id is not null then
        return new;
    end if;
    if exists (
        select 1 from contributions
         where receipt_series = new.receipt_series
           and receipt_no     = new.receipt_no
           and void_of_id is null
           and collection_uid is distinct from new.collection_uid
    ) then
        raise exception
            'GU_RECEIPT_TAKEN: receipt %/% already belongs to another collection',
            new.receipt_series, new.receipt_no
            using errcode = '23505';
    end if;
    return new;
end $$;

drop trigger if exists contributions_receipt_guard_trg on contributions;
create trigger contributions_receipt_guard_trg
    before insert on contributions
    for each row execute function public.contributions_receipt_guard();

-- =====================================================================
-- 7. EXPENSES -- what the committee spent. APPEND-ONLY.
-- =====================================================================
create table if not exists expense_categories (
    id         bigserial primary key,
    code       text    not null unique,
    name       text    not null,
    sort_order integer not null default 0,
    is_active  boolean not null default true,
    updated_at timestamptz not null default now()
);

create table if not exists expenses (
    id           bigserial primary key,
    category_id  bigint  references expense_categories (id),
    description  text    not null default '',
    vendor_name  text    not null default '',
    amount       numeric(12,2) not null,          -- negative = correction
    mode         text    not null default 'cash',
    spent_on     date    not null default current_date,
    paid_by      text    not null default '',     -- which volunteer paid
    paid_by_uid  uuid    references auth.users (id),
    bill_path    text    not null default '',     -- Supabase Storage object path
    status       text    not null default 'draft',-- 'draft' | 'approved'
    notes        text    not null default '',
    void_of_id   bigint  references expenses (id),
    created_at   timestamptz not null default now(),
    client_uid   text    unique,
    constraint exp_amount_nonzero check (amount <> 0),
    constraint exp_mode_chk check (mode in ('cash','upi','cheque','bank','other')),
    constraint exp_status_chk check (status in ('draft','approved'))
);
create index if not exists expenses_date_idx on expenses (spent_on);
create index if not exists expenses_cat_idx  on expenses (category_id);

insert into expense_categories (code, name, sort_order) values
    ('MURTI',   'Murti & Puja Samagri',    10),
    ('DECOR',   'Decoration & Pandal',     20),
    ('SOUND',   'Sound & Lighting',        30),
    ('FOOD',    'Food & Raw Material',     40),
    ('PRASAD',  'Prasad',                  50),
    ('PRIEST',  'Priest / Vidhi',          60),
    ('CULTURAL','Cultural Programme',      70),
    ('POWER',   'Generator & Electricity', 80),
    ('PRINT',   'Printing & Publicity',    90),
    ('MISC',    'Miscellaneous',          100)
on conflict (code) do nothing;

-- =====================================================================
-- 8. keep updated_at honest (Odoo's last-write-wins sync relies on it)
-- =====================================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

do $$
declare t text;
begin
    foreach t in array array['houses','event_days','app_settings','expense_categories'] loop
        execute format('drop trigger if exists %I_touch on %I', t, t);
        execute format('create trigger %I_touch before update on %I
                        for each row execute function public.touch_updated_at()', t, t);
    end loop;
end $$;

-- =====================================================================
-- 9. REPORTING VIEWS (dashboard + Odoo reports read these)
--
-- Dropped before being recreated: "create or replace view" refuses any change
-- to the column list, so re-running this file after a shape change would fail
-- on an existing project.
-- =====================================================================
drop view if exists v_day_totals        cascade;
drop view if exists v_house_day          cascade;
drop view if exists v_house_statement   cascade;
drop view if exists v_money_summary     cascade;
drop view if exists v_expense_by_category cascade;

-- plates per day.  houses_served counts only houses with a POSITIVE net for
-- that day, so a mis-entry that was undone does not leave a phantom visit.
create or replace view v_day_totals as
with per_house as (
    select event_date, house_id, sum(qty) as net
    from servings where house_id is not null
    group by event_date, house_id),
agg as (
    select event_date,
           sum(qty)                               as plates_total,
           sum(qty) filter (where not is_extra)   as plates_normal,
           sum(qty) filter (where is_extra)       as plates_extra,
           sum(qty) filter (where is_guest)       as plates_guest
    from servings group by event_date)
select d.event_date, d.day_no, d.menu_label,
       d.plate_rate,
       coalesce(a.plates_total,  0) as plates_total,
       coalesce(a.plates_normal, 0) as plates_normal,
       coalesce(a.plates_extra,  0) as plates_extra,
       coalesce(a.plates_guest,  0) as plates_guest,
       coalesce((select count(*) from per_house p
                  where p.event_date = d.event_date and p.net > 0), 0) as houses_served,
       coalesce(a.plates_total, 0) * coalesce(d.plate_rate, 0) as plate_value
from event_days d
left join agg a on a.event_date = d.event_date;

-- Registration is NOT a property of the house. It is what that house has
-- PAID FOR on that specific day. This view is the single source of truth for
-- "how many plates is this house entitled to today".
create or replace view v_house_day as
select h.id                                   as house_id,
       h.house_code,
       d.event_date,
       d.day_no,
       d.menu_label,
       coalesce(d.plate_rate, 0)              as plate_rate,
       coalesce(r.registered_qty, 0)          as registered_qty,
       coalesce(r.paid, 0)                    as paid,
       coalesce(s.taken, 0)                   as taken,
       greatest(coalesce(s.taken, 0) - coalesce(r.registered_qty, 0), 0) as over_taken
from houses h
cross join event_days d
left join (
    select house_id, event_date,
           sum(qty)    as registered_qty,
           sum(amount) as paid
    from contributions
    where purpose = 'food' and house_id is not null
    group by house_id, event_date) r
  on r.house_id = h.id and r.event_date = d.event_date
left join (
    select house_id, event_date, sum(qty) as taken
    from servings where house_id is not null
    group by house_id, event_date) s
  on s.house_id = h.id and s.event_date = d.event_date;

-- THE key report: one line per house.
--
-- There is no "expected contribution" any more. Ganpati is whatever a family
-- chooses to give, so it can never be a debt and can never show a negative.
-- The only thing a house can owe is plates taken beyond what it paid for,
-- valued at the price of the day they were taken.
create or replace view v_house_statement as
with cfg as (select extra_plate_rate from app_settings where id = 1),
money as (
    select house_id,
           sum(amount)                                       as total_given,
           sum(amount) filter (where purpose = 'ganpati')     as ganpati_given,
           sum(amount) filter (where purpose = 'food')        as food_paid,
           sum(qty)    filter (where purpose = 'food')        as plates_paid_for,
           count(distinct event_date) filter (where purpose = 'food') as days_registered,
           max(collected_at)                                  as last_paid
    from contributions where house_id is not null group by house_id),
plates as (
    select house_id,
           sum(qty)                                           as plates_total,
           count(distinct event_date) filter (where true)      as days_touched
    from servings where house_id is not null group by house_id),
attended as (
    select house_id, count(*) as days_attended
    from (select house_id, event_date from servings where house_id is not null
           group by house_id, event_date having sum(qty) > 0) q
    group by house_id),
-- plates taken beyond what was paid for, priced per day
over as (
    select hd.house_id,
           sum(hd.over_taken)                          as plates_extra,
           sum(hd.over_taken * coalesce(nullif(hd.plate_rate, 0), c.extra_plate_rate, 0))
                                                       as extra_charge
    from v_house_day hd cross join cfg c
    group by hd.house_id)
select h.id                                   as house_id,
       h.house_code, h.wing_group, h.number_label,
       h.family_name, h.member_count, h.phone, h.is_active,
       coalesce(m.ganpati_given,   0)         as ganpati_given,
       coalesce(m.food_paid,       0)         as food_paid,
       coalesce(m.total_given,     0)         as total_given,
       coalesce(m.plates_paid_for, 0)         as plates_paid_for,
       coalesce(m.days_registered, 0)         as days_registered,
       coalesce(p.plates_total,    0)         as plates_total,
       coalesce(a.days_attended,   0)         as days_attended,
       coalesce(o.plates_extra,    0)         as plates_extra,
       coalesce(o.extra_charge,    0)         as extra_charge,
       coalesce(o.extra_charge,    0)         as balance_due,
       m.last_paid
from houses h
left join money    m on m.house_id = h.id
left join plates   p on p.house_id = h.id
left join attended a on a.house_id = h.id
left join over     o on o.house_id = h.id;

-- event money summary: what came in, what went out, what is in hand
create or replace view v_money_summary as
select
    (select coalesce(sum(amount),0) from contributions)                              as collected_total,
    (select coalesce(sum(amount),0) from contributions where purpose='ganpati')      as collected_ganpati,
    (select coalesce(sum(amount),0) from contributions where purpose='food')         as collected_food,
    (select coalesce(sum(amount),0) from contributions where house_id is null)       as collected_donors,
    (select coalesce(sum(qty),0)    from contributions where purpose='food')         as plates_paid_for,
    (select coalesce(sum(amount),0) from expenses)                                   as spent_total,
    (select coalesce(sum(amount),0) from expenses where status='approved')           as spent_approved,
    (select coalesce(sum(extra_charge),0) from v_house_statement)                    as extra_due_total,
    (select coalesce(sum(amount),0) from contributions)
      - (select coalesce(sum(amount),0) from expenses)                               as balance_in_hand;

create or replace view v_expense_by_category as
select c.id as category_id, c.code, c.name, c.sort_order,
       coalesce(sum(e.amount), 0) as spent,
       count(e.id) filter (where e.void_of_id is null) as entries
from expense_categories c
left join expenses e on e.category_id = c.id
group by c.id, c.code, c.name, c.sort_order;

-- =====================================================================
-- 10. ROW LEVEL SECURITY
--
--   Anonymous gets NOTHING. The anon key committed to the public GitHub
--   repo is useless on its own -- a login is required for every read.
--
--   volunteer : read everything, add + undo servings,
--               collect contributions, record expenses as 'draft'
--   admin     : additionally edit roster / days / settings, approve expenses
-- =====================================================================
alter table app_settings       enable row level security;
alter table houses             enable row level security;
alter table event_days         enable row level security;
alter table servings           enable row level security;
alter table contributions      enable row level security;
alter table expenses           enable row level security;
alter table expense_categories enable row level security;
alter table profiles           enable row level security;

-- read-for-all-signed-in
do $$
declare t text;
begin
    foreach t in array array['app_settings','houses','event_days','servings',
                             'contributions','expenses','expense_categories','profiles'] loop
        execute format('drop policy if exists %I_read on %I', t, t);
        execute format('create policy %I_read on %I for select to authenticated using (true)', t, t);
    end loop;
end $$;

-- admin-only writes on master data
do $$
declare t text;
begin
    foreach t in array array['app_settings','houses','event_days','expense_categories'] loop
        execute format('drop policy if exists %I_ins on %I', t, t);
        execute format('drop policy if exists %I_upd on %I', t, t);
        execute format('create policy %I_ins on %I for insert to authenticated
                        with check (public.is_admin())', t, t);
        execute format('create policy %I_upd on %I for update to authenticated
                        using (public.is_admin()) with check (public.is_admin())', t, t);
    end loop;
end $$;

-- ledgers: insert-only for any signed-in volunteer. No UPDATE and no DELETE
-- policy is defined anywhere, which is what makes them append-only in fact
-- and not merely by convention.
drop policy if exists servings_ins on servings;
create policy servings_ins on servings for insert to authenticated with check (true);

drop policy if exists contributions_ins on contributions;
create policy contributions_ins on contributions for insert to authenticated
    with check (exists (select 1 from profiles
                        where id = auth.uid() and (can_collect or role = 'admin')));

drop policy if exists expenses_ins on expenses;
create policy expenses_ins on expenses for insert to authenticated
    with check (exists (select 1 from profiles
                        where id = auth.uid() and (can_expense or role = 'admin')));

-- only an admin may flip an expense draft -> approved
drop policy if exists expenses_approve on expenses;
create policy expenses_approve on expenses for update to authenticated
    using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
-- 11. STORAGE bucket for bill photos (private; signed URLs only)
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('bills', 'bills', false) on conflict (id) do nothing;

drop policy if exists bills_read on storage.objects;
create policy bills_read on storage.objects for select to authenticated
    using (bucket_id = 'bills');
drop policy if exists bills_write on storage.objects;
create policy bills_write on storage.objects for insert to authenticated
    with check (bucket_id = 'bills');

-- =====================================================================
-- 12. REALTIME -- push changes to every connected phone
-- =====================================================================
do $$
declare t text;
begin
    foreach t in array array['servings','contributions','expenses',
                             'houses','event_days'] loop
        begin
            execute format('alter publication supabase_realtime add table %I', t);
        exception when duplicate_object then null;
        end;
    end loop;
end $$;
