ALTER TABLE public.top_gainers ADD COLUMN IF NOT EXISTS insight_fortified integer DEFAULT 0;
ALTER TABLE public.top_losers ADD COLUMN IF NOT EXISTS insight_fortified integer DEFAULT 0;