import {createGetDb} from '@agent-native/core/db';
import {registerIdentityColumns} from '@agent-native/core/org';
import * as schema from './schema.js';

export const getDb = createGetDb(schema);

const notAnIdentity = 'Holds "agent" or "person" (who made the last change), never an email address.';
registerIdentityColumns(
  ['drone_plans', 'drone_assignments', 'briefings', 'detections'].map(table => ({
    table,
    column: 'updated_by',
    emailChange: 'retain' as const,
    offboard: 'retain' as const,
    reason: notAnIdentity
  }))
);
