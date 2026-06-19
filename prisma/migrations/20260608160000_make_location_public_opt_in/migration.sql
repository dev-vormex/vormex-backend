-- Location storage and public nearby visibility are separate privacy concepts.
-- Historical app versions made users public whenever they stored coordinates,
-- so reset existing public flags conservatively. Users can explicitly opt in
-- again through /api/location/settings with shareLocationPublic=true.
UPDATE "users"
SET "shareLocationPublic" = false
WHERE "shareLocationPublic" = true;
