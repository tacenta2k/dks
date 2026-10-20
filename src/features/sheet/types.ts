import type { ColumnDefinition, ColumnType, DropdownOptions } from '../../lib/columns';

export interface SheetRow {
  id: string;
  data: Record<string, unknown>;
  category?: string | null;
  deleted?: boolean;
  updatedAt?: string;
  updated_at?: string;
}

export interface ColumnInput {
  id?: string;
  name: string;
  type: ColumnType;
  options?: DropdownOptions;
  isPassport?: boolean;
  is_passport?: boolean;
}

export interface SheetTemplate {
  id: string;
  name: string;
  description?: string;
  columns: ColumnDefinition[];
  rows?: SheetRow[];
}

export interface SheetSnapshot {
  columns: ColumnDefinition[];
  rows: SheetRow[];
}

export interface RenewalRecord {
  id: string;
  rowId: string;
  expiryColumnId: string;
  previousExpiry: string | null;
  nextExpiry: string;
  renewedAt: string;
}
