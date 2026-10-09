-- Sign-in history lookups filter the audit log by actor.
CREATE INDEX audit_log_actor ON audit_log(actor, id);
