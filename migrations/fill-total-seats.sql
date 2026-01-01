-- Migration script to fill totalSeats for existing trips
-- This script should be run after the totalSeats column is added to the trips table

-- Set totalSeats = availableSeats for all existing trips where totalSeats is NULL
-- This assumes that for existing trips, the availableSeats represents the total capacity
UPDATE trips 
SET "totalSeats" = "availableSeats" 
WHERE "totalSeats" IS NULL;

-- After running this, you can make totalSeats NOT NULL if needed
-- ALTER TABLE trips ALTER COLUMN "totalSeats" SET NOT NULL;

