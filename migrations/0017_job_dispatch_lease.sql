-- Queue acceptance is not execution. Suppress repeated dispatch while retaining
-- bounded recovery after a crash or an unknown Queue send outcome.
ALTER TABLE jobs ADD COLUMN dispatch_until TEXT;
