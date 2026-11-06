import {runMigrations} from '@agent-native/core/db';

/** Drone-planning tables (server/db/schema.ts). Additive only; append new entries with a new name. */
export default runMigrations(
  [
    {
      version: 1,
      name: 'plan-drone-plans',
      sql: `CREATE TABLE IF NOT EXISTS drone_plans (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT '',
        fire TEXT NOT NULL,
        hour_key TEXT NOT NULL,
        t TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
        approved_at TEXT,
        created_at TEXT NOT NULL DEFAULT now(),
        updated_at TEXT NOT NULL DEFAULT now(),
        updated_by TEXT NOT NULL DEFAULT 'person' CHECK (updated_by IN ('agent', 'person'))
      )`
    },
    {
      version: 2,
      name: 'plan-drone-plans-unique-hour',
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS drone_plans_org_fire_hour ON drone_plans (org_id, fire, hour_key)`
    },
    {
      version: 3,
      name: 'plan-drone-assignments',
      sql: `CREATE TABLE IF NOT EXISTS drone_assignments (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        drone_id TEXT NOT NULL CHECK (drone_id IN ('D1', 'D2', 'D3', 'D4', 'D5', 'D6')),
        lon DOUBLE PRECISION NOT NULL,
        lat DOUBLE PRECISION NOT NULL,
        radius_m DOUBLE PRECISION NOT NULL DEFAULT 400,
        locked BOOLEAN NOT NULL DEFAULT false,
        reason TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT now(),
        updated_by TEXT NOT NULL DEFAULT 'person' CHECK (updated_by IN ('agent', 'person'))
      )`
    },
    {
      version: 4,
      name: 'plan-drone-assignments-unique-drone',
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS drone_assignments_plan_drone ON drone_assignments (plan_id, drone_id)`
    },
    {
      version: 5,
      name: 'plan-briefings',
      sql: `CREATE TABLE IF NOT EXISTS briefings (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        paragraphs JSONB NOT NULL,
        dropped JSONB NOT NULL,
        created_at TEXT NOT NULL DEFAULT now(),
        updated_at TEXT NOT NULL DEFAULT now(),
        updated_by TEXT NOT NULL DEFAULT 'person' CHECK (updated_by IN ('agent', 'person'))
      )`
    },
    {
      version: 6,
      name: 'plan-briefings-unique-plan',
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS briefings_plan ON briefings (plan_id)`
    },
    {
      version: 7,
      name: 'plan-detections',
      sql: `CREATE TABLE IF NOT EXISTS detections (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT '',
        fire TEXT NOT NULL,
        t TEXT NOT NULL,
        lon DOUBLE PRECISION NOT NULL,
        lat DOUBLE PRECISION NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT now(),
        updated_by TEXT NOT NULL DEFAULT 'person' CHECK (updated_by IN ('agent', 'person'))
      )`
    },
    {
      version: 8,
      name: 'plan-detections-index',
      sql: `CREATE INDEX IF NOT EXISTS detections_org_fire_t ON detections (org_id, fire, t)`
    }
  ],
  {table: 'sentinel_plan_migrations'}
);
