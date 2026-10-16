-- NULL identifies legacy all-seat observations; the next filtered observation is a silent baseline.
ALTER TABLE library_watches ADD COLUMN seat_policy TEXT;
