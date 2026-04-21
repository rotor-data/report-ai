-- 024_blueprints_modules_optional.sql
-- Legacy blueprints required `modules` JSONB. Smart blueprints use
-- `slots` and leave modules NULL. Drop the NOT NULL + default.
ALTER TABLE report_blueprints ALTER COLUMN modules DROP NOT NULL;
ALTER TABLE report_blueprints ALTER COLUMN modules DROP DEFAULT;
