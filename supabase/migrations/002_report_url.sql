ALTER TABLE public.top_gainers ADD COLUMN IF NOT EXISTS report_url text;
ALTER TABLE public.top_losers ADD COLUMN IF NOT EXISTS report_url text;
