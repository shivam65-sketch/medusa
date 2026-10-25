-- Each definition has exactly one current version, and it is its newest one. The Markets page
-- runs the current version, so none (or two) would leave it without an answer (or with two).
-- Any row returned breaks the rule.
select metric_id,
       count(case when is_current then 1 end)              as current_versions,
       max(version)                                        as newest_version,
       max(case when is_current then version end)          as current_version
from {{ source('semantic', 'metric_definitions') }}
group by metric_id
having count(case when is_current then 1 end) <> 1
    or max(case when is_current then version end) <> max(version)
