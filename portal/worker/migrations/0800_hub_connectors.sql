-- Connections visibility (phase 1): latest validated snapshot of the connector names and states a Hub reports. No credentials, URLs or hosts.
ALTER TABLE hubs ADD COLUMN connectors_json TEXT;
