-- Hosts in this Hub (mesh): latest validated snapshot of the machines a Hub spans and which Albena parts run on each. Opaque ids, user labels only; no hostnames or addresses.
ALTER TABLE hubs ADD COLUMN mesh_json TEXT;
