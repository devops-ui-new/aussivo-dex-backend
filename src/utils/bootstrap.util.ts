import { seedAdmin } from '../seeders/seedAdmin';
import { seedVaults } from '../seeders/seedVaults';

export const bootstrapDB = async (callback: () => void) => {
  await seedAdmin();
  await seedVaults();
  callback();
};
