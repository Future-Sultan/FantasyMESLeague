-- ===========================================================================
-- Run this ONLY if you already ran schema.sql before player prices existed.
-- On a fresh project schema.sql already includes everything here.
-- Safe to run twice.
-- ===========================================================================

alter table players add column if not exists price numeric(4,1) not null default 5.0;
alter table config  add column if not exists budget numeric(5,1) not null default 70.0;

-- everyone starts at the same price; set real ones from the moderator page
update players set price = 5.0 where price is null;
update config  set budget = 70.0 where id = 1 and budget is null;
