-- Run once, with the database owner; never grant this identity to the application.
BEGIN;
CREATE TABLE governance_schema (version integer PRIMARY KEY, installed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE governance_events (
    tenant text NOT NULL CHECK (tenant = 'shared' OR tenant ~ '^[a-f0-9]{64}$'),
    subject text NOT NULL CHECK (subject ~ '^[a-f0-9]{64}$'),
    sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 256),
    project text NOT NULL CHECK (project ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$'),
    -- Keep the exact canonical JSON bytes: jsonb reserialization would change the audit hash.
    event text NOT NULL CHECK (octet_length(event) <= 65536 AND jsonb_typeof(event::jsonb) = 'object'),
    hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY (tenant, subject, sequence)
);
CREATE INDEX governance_projects ON governance_events (tenant, project, subject, sequence);
CREATE TABLE governance_nonces (nonce text PRIMARY KEY CHECK (nonce ~ '^[a-f0-9]{64}$'), expires bigint NOT NULL);
CREATE INDEX governance_nonce_expiry ON governance_nonces (expires);
CREATE FUNCTION reject_governance_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GOVERNANCE_EVENTS_IMMUTABLE'; END;
$$;
CREATE TRIGGER immutable_governance_rows BEFORE UPDATE OR DELETE ON governance_events FOR EACH ROW EXECUTE FUNCTION reject_governance_mutation();
CREATE TRIGGER immutable_governance_truncate BEFORE TRUNCATE ON governance_events FOR EACH STATEMENT EXECUTE FUNCTION reject_governance_mutation();
REVOKE ALL ON governance_events, governance_nonces, governance_schema FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO modelling_app;
GRANT SELECT, INSERT ON governance_events TO modelling_app;
GRANT SELECT, INSERT, DELETE ON governance_nonces TO modelling_app;
GRANT SELECT ON governance_schema TO modelling_app;
INSERT INTO governance_schema (version) VALUES (1);
COMMIT;
