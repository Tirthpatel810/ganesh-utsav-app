-- =====================================================================
--  GANESH UTSAV -- SEED DATA
--  Run AFTER schema.sql. Re-runnable (upserts on natural keys).
--
--  >>> EDIT THE ROSTER SECTION TO MATCH YOUR SOCIETY <<<
-- =====================================================================

-- ---------------------------------------------------------------------
-- Money settings
--   contribution_default : Rs.500 per house (per-house override allowed)
--   extra_plate_rate     : FALLBACK only. Each day carries its own price in
--                          event_days.plate_rate, and that is what an extra
--                          plate is actually charged at. This value is used
--                          only for a date that is not a listed event day.
-- ---------------------------------------------------------------------
update app_settings set
    event_name           = 'Ganesh Mahotsav 2026',
    event_year           = 2026,
    receipt_prefix       = 'GU26',
    contribution_default = 500.00,
    extra_plate_rate     = 60.00,
    currency_symbol      = '₹',
    allow_extra_plates   = true
where id = 1;

-- ---------------------------------------------------------------------
-- The 7 days, each with its own menu and its own plate price.
--
-- The seven plates total Rs.600 per person while the contribution is
-- Rs.500, so the event carries a Rs.100 per-person subsidy before any
-- sponsorship. Worth knowing before the committee sets the amount.
--
-- Serving window is a soft warning, never a block.
-- ---------------------------------------------------------------------
insert into event_days (event_date, day_no, menu_label, plate_rate,
                        window_start, window_end, is_open) values
    ('2026-09-14', 1, 'Live Dhokla with Chutney',      60.00, '19:00', '22:30', true),
    ('2026-09-15', 2, 'Idli Sambar with Chutney',      70.00, '19:00', '22:30', true),
    ('2026-09-16', 3, 'Moong Pulao',                   50.00, '19:00', '22:30', true),
    ('2026-09-17', 4, 'Sev Usal with Pav',             80.00, '19:00', '22:30', true),
    ('2026-09-18', 5, 'Chhole Bhature with Chaas',     90.00, '19:00', '22:30', true),
    ('2026-09-19', 6, 'Pav Bhaji with Pulav',         100.00, '19:00', '22:30', true),
    ('2026-09-20', 7, 'Full Dish',                    150.00, '19:30', '23:00', true)
on conflict (event_date) do update set
    day_no = excluded.day_no, menu_label = excluded.menu_label,
    plate_rate = excluded.plate_rate,
    window_start = excluded.window_start, window_end = excluded.window_end,
    is_open = excluded.is_open;

-- =====================================================================
--  ROSTER   ##### EDIT THIS SECTION #####
--
--  wing_group   -> which top tab the button appears under ('AB', 'C')
--  number_label -> the text printed ON the button. Keep it SHORT.
--  house_code   -> permanent unique id. Never renumber or reuse it.
--  sort_order   -> button order within the tab
--  member_count -> registered plates PER DAY this house asked for.
--                  Plates beyond this become chargeable EXTRA.
--  contribution_expected -> what this house owes (default 500)
--
--  Merged flats are ONE row = ONE button:
--      ('A-65-66', 'AB', '65-66', 6566, 'Patel', 6, 500)
-- =====================================================================

-- Wing A : flats 1 - 10
insert into houses (house_code, wing_group, number_label, sort_order,
                    family_name, member_count, contribution_expected)
select 'A-'||n, 'AB', n::text, n, '', 4, 500 from generate_series(1,10) n
on conflict (house_code) do nothing;

-- Wing B : flats 11 - 60   (B has no 1-10; A/B share one continuous series)
insert into houses (house_code, wing_group, number_label, sort_order,
                    family_name, member_count, contribution_expected)
select 'B-'||n, 'AB', n::text, n, '', 4, 500 from generate_series(11,60) n
on conflict (house_code) do nothing;

-- Wing C : flats 1 - 57    (C restarts its own numbering at 1)
insert into houses (house_code, wing_group, number_label, sort_order,
                    family_name, member_count, contribution_expected)
select 'C-'||n, 'C', n::text, n, '', 4, 500 from generate_series(1,57) n
on conflict (house_code) do nothing;

-- Example merged flat -- copy this pattern for your real merged flats
-- insert into houses (house_code, wing_group, number_label, sort_order,
--                     family_name, member_count, contribution_expected)
-- values ('A-65-66','AB','65-66',6566,'Patel',6,500)
-- on conflict (house_code) do nothing;

select wing_group,
       count(*)                     as houses,
       sum(member_count)            as registered_plates_per_day,
       sum(contribution_expected)   as expected_collection
from houses where is_active group by wing_group order by wing_group;

select day_no, menu_label, plate_rate from event_days order by day_no;
select sum(plate_rate) as menu_value_per_person from event_days;
