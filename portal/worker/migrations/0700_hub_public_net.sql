-- Hub public network info (current values only, no history): taken from the signed heartbeat request, shown to the account owner and staff.
ALTER TABLE hubs ADD COLUMN net_ip TEXT;
ALTER TABLE hubs ADD COLUMN net_isp TEXT;
ALTER TABLE hubs ADD COLUMN net_asn INTEGER;
ALTER TABLE hubs ADD COLUMN net_city TEXT;
ALTER TABLE hubs ADD COLUMN net_region TEXT;
ALTER TABLE hubs ADD COLUMN net_country TEXT;
ALTER TABLE hubs ADD COLUMN net_tz TEXT;
ALTER TABLE hubs ADD COLUMN net_changed_at INTEGER;
