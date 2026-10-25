-- The rules every metric definition follows, so the Markets page can run it and show it.
-- Any row returned breaks one of them.
--   one row per metric and version, numbered 1, 2, 3 ... with no gaps
--   a version's dates make sense: only old versions have valid_to, and it isn't before valid_from
--   the id is a plain name (lowercase letters, digits, _), because queries read models by name
--   the SQL is one read-only statement: it starts with SELECT or WITH and has no ;
--   every metric says how it is shown (display), and display is valid JSON
with defs as (
    select * from {{ source('semantic', 'metric_definitions') }}
),

versions as (
    select metric_id, count(*) as versions, count(distinct version) as distinct_versions,
           min(version) as first_version, max(version) as last_version
    from defs
    group by metric_id
)

select metric_id, null as version, 'versions repeat or have gaps' as problem
from versions
where versions <> distinct_versions or first_version <> 1 or last_version <> versions

union all

select metric_id, version, 'valid_to does not match is_current, or comes before valid_from' as problem
from defs
where (is_current and valid_to is not null)
   or (not is_current and valid_to is null)
   or valid_to < valid_from

union all

select metric_id, version, 'id is not a plain lowercase name' as problem
from defs
where not metric_id rlike '^[a-z][a-z0-9_]*$'

union all

-- Tabs and line breaks become spaces first, so a query may start on a new line.
select metric_id, version, 'SQL is not one read-only statement (SELECT or WITH, no ;)' as problem
from defs
where not upper(ltrim(translate(sql_text, concat(char(9), char(10), char(13)), '   '))) rlike '^(SELECT|WITH)[^A-Z0-9_]'
   or sql_text like '%;%'

union all

select metric_id, version, 'a metric without display, or display that is not JSON' as problem
from defs
where (kind = 'metric' and display is null)
   or (display is not null and try_parse_json(display) is null)
