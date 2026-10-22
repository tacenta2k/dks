import type { ColumnDefinition, ColumnType, DropdownOptions } from '../../lib/columns';
import type { AuditEntry } from '../audit/audit-types';

export type { AuditEntry } from '../audit/audit-types';

export interface SheetRow {
  id: string;
  data: Record<string, unknown>;
  category?: string | null;
  deleted?: boolean;
  updatedAt?: string;
  updated_at?: string;
  updatedBy?: string | null;
  updated_by?: string | null;
  deletedAt?: string | null;
  deleted_at?: string | null;
  deletedBy?: string | null;
  deleted_by?: string | null;
}

export interface ColumnInput {
  id?: string;
  name: string;
  type: ColumnType;
  options?: DropdownOptions;
  isPassport?: boolean;
  is_passport?: boolean;
}

export interface SheetSnapshot {
  columns: ColumnDefinition[];
  rows: SheetRow[];
}

/** A renderer-owned row shape used when an import is ready to be persisted. */
export interface SheetImportRecord {
  data: Record<string, unknown>;
  category?: string | null;
  sourceRowNumber?: number;
}

/** Optional attribution and source details for repository audit events. */
export interface SheetAuditOptions {
  actorId?: string | null;
  actor?: string | null;
  fileName?: string | null;
}

export type SheetAuditEntry = AuditEntry;

export interface RenewalRecord {
  id: string;
  rowId: string;
  expiryColumnId: string;
  previousExpiry: string | null;
  nextExpiry: string;
  renewedAt: string;
}
