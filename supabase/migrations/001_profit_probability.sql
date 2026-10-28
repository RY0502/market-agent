begin;

alter table public.top_gainers add column if not exists profit_probability text;
alter table public.top_losers add column if not exists profit_probability text;

do $$
declare t text;
begin
  foreach t in array array['top_gainers', 'top_losers'] loop
    if not exists (
      select 1 from pg_constraint where conrelid = format('public.%I', t)::regclass
        and conname = t || '_profit_probability_check'
    ) then
      execute format('alter table public.%I add constraint %I
        check (profit_probability in (''low'', ''medium'', ''high''))',
        t, t || '_profit_probability_check');
    end if;
  end loop;
end $$;

commit;
