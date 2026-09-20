-- ===========================================================================
-- Run this ONLY if you already ran schema.sql before the manual points
-- override column existed. On a fresh project schema.sql already includes it.
-- Safe to run twice.
-- ===========================================================================

alter table match_stats add column if not exists override_pts int;
