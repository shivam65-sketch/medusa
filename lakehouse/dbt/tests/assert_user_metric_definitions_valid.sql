-- The rules every personal version follows, so the account's Markets page can run it.
-- Any row returned breaks one of them.
--   per account and definition: versions numbered 1, 2, 3 ... with no gaps
--   at most one current version, and when there is one it is the newest
--   a version's dates make sense: only versions no longer in use have valid_to, and not before valid_from
--   the SQL is one read-only statement: it starts with SELECT or WITH and has no ;
with defs as (
    select * from {{ source('semantic', 'user_metric_definitions') }}
),

per_metric as (
    select account_id, metric_id,
           count(*) as versions, count(distinct version) as distinct_versions,
           min(version) as first_version, max(version) as last_version,
           count(case when is_current then 1 end) as current_versions,
           max(case when is_current then version end) as current_version
    from defs
    group by account_id, metric_id
)

select account_id, metric_id, null as version, 'versions repeat or have gaps' as problem
from per_metric
where versions <> distinct_versions or first_version <> 1 or last_version <> versions

union all

select account_id, metric_id, null as version, 'more than one current version, or the current one is not the newest' as problem
from per_metric
where current_versions > 1 or (current_versions = 1 and current_version <> last_version)

union all

select account_id, metric_id, version, 'valid_to does not match is_current, or comes before valid_from' as problem
from defs
where (is_current and valid_to is not null)
   or (not is_current and valid_to is null)
   or valid_to < valid_from

union all

-- Tabs and line breaks become spaces first, so a query may start on a new line.
select account_id, metric_id, version, 'SQL is not one read-only statement (SELECT or WITH, no ;)' as problem
from defs
where not upper(ltrim(translate(sql_text, concat(char(9), char(10), char(13)), '   '))) rlike '^(SELECT|WITH)[^A-Z0-9_]'
   or sql_text like '%;%'
