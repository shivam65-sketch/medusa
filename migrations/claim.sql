-- Moves the journal from before accounts (user_id 0) into one account. Run it after creating that
-- account in the app. Replace every YOUR_USERNAME below with the account's email (lowercase):
--   npx wrangler@4 d1 execute medusa --remote --file=migrations/claim.sql
-- Nothing happens if that email has no account. Rows the account already has with the same key
-- (for example settings saved right after signing up) are replaced by the old ones.

UPDATE OR REPLACE orders SET user_id = (SELECT id FROM users WHERE username = 'YOUR_USERNAME') WHERE user_id = 0 AND EXISTS (SELECT 1 FROM users WHERE username = 'YOUR_USERNAME');
UPDATE OR REPLACE txs SET user_id = (SELECT id FROM users WHERE username = 'YOUR_USERNAME') WHERE user_id = 0 AND EXISTS (SELECT 1 FROM users WHERE username = 'YOUR_USERNAME');
UPDATE OR REPLACE trades SET user_id = (SELECT id FROM users WHERE username = 'YOUR_USERNAME') WHERE user_id = 0 AND EXISTS (SELECT 1 FROM users WHERE username = 'YOUR_USERNAME');
UPDATE OR REPLACE triggers SET user_id = (SELECT id FROM users WHERE username = 'YOUR_USERNAME') WHERE user_id = 0 AND EXISTS (SELECT 1 FROM users WHERE username = 'YOUR_USERNAME');
UPDATE OR REPLACE annotations SET user_id = (SELECT id FROM users WHERE username = 'YOUR_USERNAME') WHERE user_id = 0 AND EXISTS (SELECT 1 FROM users WHERE username = 'YOUR_USERNAME');
UPDATE OR REPLACE days SET user_id = (SELECT id FROM users WHERE username = 'YOUR_USERNAME') WHERE user_id = 0 AND EXISTS (SELECT 1 FROM users WHERE username = 'YOUR_USERNAME');
UPDATE OR REPLACE kv SET user_id = (SELECT id FROM users WHERE username = 'YOUR_USERNAME') WHERE user_id = 0 AND EXISTS (SELECT 1 FROM users WHERE username = 'YOUR_USERNAME');
SELECT (SELECT id FROM users WHERE username = 'YOUR_USERNAME') AS claimed_by, (SELECT COUNT(*) FROM trades WHERE user_id = 0) AS trades_left_unclaimed;
