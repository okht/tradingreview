import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const workspaces = sqliteTable('workspaces', { ownerId: text('owner_id').primaryKey(), stateJson: text('state_json').notNull(), revision: integer('revision').notNull(), updatedAt: text('updated_at').notNull() });
export const analysisRuns = sqliteTable('analysis_runs', { id: text('id').primaryKey(), ownerId: text('owner_id').notNull(), snapshotJson: text('snapshot_json').notNull(), createdAt: text('created_at').notNull() });
