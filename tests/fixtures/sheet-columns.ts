import type { SheetRepository } from '../../src/features/sheet/repository';
import type { ColumnInput } from '../../src/features/sheet/types';

/**
 * Generic user-created columns for tests (F3: no hard-coded Category,
 * Visa Type or Notes business columns are seeded by the product; tests
 * create their own columns explicitly, like a real workspace would).
 */
export const fixtureColumnInputs: readonly ColumnInput[] = [
  { id: 'name', name: 'Name', type: 'text' },
  { id: 'passport_no', name: 'Passport No', type: 'text', isPassport: true },
  { id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry' },
  { id: 'country', name: 'Country', type: 'text' },
];

export async function seedFixtureColumns(repository: SheetRepository): Promise<void> {
  for (const input of fixtureColumnInputs) {
    await repository.addColumn({ ...input });
  }
}
