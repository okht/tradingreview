-- Local-only fixture to verify D1 owner filtering; no model/provider call.
INSERT INTO analysis_runs (id, owner_id, snapshot_json, created_at)
VALUES ('87900000-0000-4000-8000-000000000001', 'huikan-local-d1-alice', '{"id":"87900000-0000-4000-8000-000000000001","result":{"text":"LOCAL SQL FIXTURE ONLY"},"createdAt":"2026-10-21T00:00:00Z"}', '2026-10-21T00:00:00Z');
