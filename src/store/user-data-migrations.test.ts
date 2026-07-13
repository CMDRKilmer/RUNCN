/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@src/store/user-data-versioned-migrations', () => ({
  migrateVersionedUserData: vi.fn(),
}));

import { migrateUserData } from './user-data-migrations';
import { migrateVersionedUserData } from '@src/store/user-data-versioned-migrations';

function createUserData(overrides: Record<string, any> = {}): any {
  return {
    settings: {
      disabled: [],
      sidebar: [
        ['Help', 'XIT HELP'],
        ['BURN', 'XIT BURN'],
      ],
    },
    actionPackages: [],
    ...overrides,
  };
}

describe('migrateUserData', () => {
  describe('fresh user data (no migrations field)', () => {
    it('marks all migrations as applied and compacts the list', () => {
      const userData = createUserData();
      const result = migrateUserData(userData);

      // Should contain the checkpoint instead of individual pre-checkpoint entries.
      expect(result.migrations).toContain('10.03.2026 Checkpoint');
      // Should NOT contain individual entries that the checkpoint replaces.
      expect(result.migrations).not.toContain('25.12.2025 Add audio volume');
      expect(result.migrations).not.toContain('10.03.2026 Remove funny-rations');
      // Should contain post-checkpoint entries.
      expect(result.migrations).toContain('15.03.2026 Add factionToken');
      expect(result.migrations).toContain('08.07.2026 Migrate to per-provider API configs');
    });

    it('returns without executing migration functions (fresh data is already current)', () => {
      const userData = createUserData();
      const result = migrateUserData(userData);

      // Fresh data path: just mark everything as done, don't run mutations.
      expect(result.migrations).toContain('10.03.2026 Checkpoint');
      // Side-effects are NOT applied for fresh users.
      expect(userData.fullEquityMode).toBeUndefined();
    });
  });

  describe('idempotency', () => {
    it('running twice produces the same data and migration list', () => {
      const userData = createUserData();
      migrateUserData(userData);
      const snapshot = JSON.parse(JSON.stringify(userData));

      migrateUserData(userData);

      expect(userData).toEqual(snapshot);
    });
  });

  describe('versioned user data transition', () => {
    it('calls migrateVersionedUserData then runs all named migrations', () => {
      const userData = createUserData({ version: 5 });
      migrateUserData(userData);

      expect(vi.mocked(migrateVersionedUserData)).toHaveBeenCalledWith(userData);
      expect(userData.version).toBeUndefined();
      // All named migrations should now be applied.
      expect(userData.migrations.length).toBeGreaterThan(0);
    });
  });

  describe('partially migrated user', () => {
    it('only runs migrations not yet applied', () => {
      // Simulate a user who has everything up to and including the checkpoint.
      const userData = createUserData({
        migrations: [
          '25.12.2025 Add audio volume',
          '25.12.2025 Rename features',
          '02.02.2026 Add full equity mode',
          '24.01.2026 Remove cxpc-default-1y',
          '10.03.2026 Remove funny-rations',
          '10.03.2026 Checkpoint',
        ],
      });
      const result = migrateUserData(userData);

      // Post-checkpoint migrations should now be present.
      expect(result.migrations).toContain('15.03.2026 Add factionToken');
      expect(result.migrations).toContain('08.07.2026 Migrate to per-provider API configs');
      // Post-checkpoint side-effects should be applied.
      expect(userData.settings.mutedDesktopNotifications).toEqual([]);
      expect(userData.factionToken).toBeUndefined();
    });
  });

  describe('cart migration (03.04.2026 Add shopping cart)', () => {
    it('creates cart object when missing', () => {
      const userData = createUserData({
        migrations: [
          '25.12.2025 Add audio volume',
          '25.12.2025 Rename features',
          '02.02.2026 Add full equity mode',
          '24.01.2026 Remove cxpc-default-1y',
          '10.03.2026 Remove funny-rations',
          '10.03.2026 Checkpoint',
          '15.03.2026 Add factionToken',
          '15.03.2026 Add factionCache',
          '16.03.2026 Add JH sidebar entry',
          '17.03.2026 Add supabaseAuth',
          '17.03.2026 Add lastAutoProductionDate',
          '18.03.2026 Add mutedDesktopNotifications',
          '21.03.2026 Replace JH with 计划 and add 组织 sidebar entry',
          '21.03.2026 Translate sidebar entries',
          '25.03.2026 Rename BURN to 报告',
          '03.04.2026 Remove ship refuel actions',
        ],
      });

      migrateUserData(userData);

      expect(userData.cart).toBeDefined();
      expect(userData.cart.name).toBe('Shopping Cart');
      expect(userData.cart.exchange).toBe('');
      expect(userData.cart.items).toEqual([]);
    });

    it('adds XIT CART sidebar entry after FACTION if present', () => {
      const userData = createUserData({
        migrations: [
          '25.12.2025 Add audio volume',
          '25.12.2025 Rename features',
          '02.02.2026 Add full equity mode',
          '24.01.2026 Remove cxpc-default-1y',
          '10.03.2026 Remove funny-rations',
          '10.03.2026 Checkpoint',
          '15.03.2026 Add factionToken',
          '15.03.2026 Add factionCache',
          '16.03.2026 Add JH sidebar entry',
          '17.03.2026 Add supabaseAuth',
          '17.03.2026 Add lastAutoProductionDate',
          '18.03.2026 Add mutedDesktopNotifications',
          '21.03.2026 Replace JH with 计划 and add 组织 sidebar entry',
          '21.03.2026 Translate sidebar entries',
          '25.03.2026 Rename BURN to 报告',
          '03.04.2026 Remove ship refuel actions',
        ],
        settings: {
          disabled: [],
          sidebar: [
            ['Help', 'XIT HELP'],
            ['报告', 'XIT BURN'],
            ['组织', 'XIT FACTION'],
            ['设置', 'XIT SET'],
          ],
        },
      });

      migrateUserData(userData);

      const cartEntry = userData.settings.sidebar.find(
        ([, cmd]: [string, string]) => cmd === 'XIT CART',
      );
      expect(cartEntry).toBeDefined();
      // Should be after FACTION.
      const factionIdx = userData.settings.sidebar.findIndex(
        ([, cmd]: [string, string]) => cmd === 'XIT FACTION',
      );
      const cartIdx = userData.settings.sidebar.findIndex(
        ([, cmd]: [string, string]) => cmd === 'XIT CART',
      );
      expect(cartIdx).toBe(factionIdx + 1);
    });
  });

  describe('Refuel removal migration (03.04.2026)', () => {
    it('removes Refuel actions from action packages', () => {
      const userData = createUserData({
        migrations: [
          '25.12.2025 Add audio volume',
          '25.12.2025 Rename features',
          '02.02.2026 Add full equity mode',
          '24.01.2026 Remove cxpc-default-1y',
          '10.03.2026 Remove funny-rations',
          '10.03.2026 Checkpoint',
          '15.03.2026 Add factionToken',
          '15.03.2026 Add factionCache',
          '16.03.2026 Add JH sidebar entry',
          '17.03.2026 Add supabaseAuth',
          '17.03.2026 Add lastAutoProductionDate',
          '18.03.2026 Add mutedDesktopNotifications',
          '21.03.2026 Replace JH with 计划 and add 组织 sidebar entry',
          '21.03.2026 Translate sidebar entries',
          '25.03.2026 Rename BURN to 报告',
        ],
        actionPackages: [
          {
            actions: [{ type: 'Refuel' }, { type: 'BuyMaterial' }, { type: 'Refuel' }],
          },
        ],
      });

      migrateUserData(userData);

      expect(userData.actionPackages[0].actions).toEqual([{ type: 'BuyMaterial' }]);
    });
  });

  describe('translation provider config migration (08.07.2026)', () => {
    it('moves top-level apiKey/apiUrl/apiModel into per-provider configs', () => {
      const userData = createUserData({
        migrations: [
          '25.12.2025 Add audio volume',
          '25.12.2025 Rename features',
          '02.02.2026 Add full equity mode',
          '24.01.2026 Remove cxpc-default-1y',
          '10.03.2026 Remove funny-rations',
          '10.03.2026 Checkpoint',
          '15.03.2026 Add factionToken',
          '15.03.2026 Add factionCache',
          '16.03.2026 Add JH sidebar entry',
          '17.03.2026 Add supabaseAuth',
          '17.03.2026 Add lastAutoProductionDate',
          '18.03.2026 Add mutedDesktopNotifications',
          '21.03.2026 Replace JH with 计划 and add 组织 sidebar entry',
          '21.03.2026 Translate sidebar entries',
          '25.03.2026 Rename BURN to 报告',
          '03.04.2026 Remove ship refuel actions',
          '03.04.2026 Add shopping cart',
          '03.04.2026 Rename default cart name',
          '07.07.2026 Add translation settings',
        ],
        settings: {
          disabled: [],
          sidebar: [],
          translation: {
            enabled: true,
            provider: 'MICROSOFT',
            targetLanguage: 'zh',
            apiKey: 'secret-key',
            apiUrl: 'https://api.example.com',
            apiModel: 'gpt-4',
          },
        },
      });

      migrateUserData(userData);

      // Top-level keys should be removed.
      expect(userData.settings.translation.apiKey).toBeUndefined();
      expect(userData.settings.translation.apiUrl).toBeUndefined();
      expect(userData.settings.translation.apiModel).toBeUndefined();
      // Per-provider config should be populated with the old values.
      expect(userData.settings.translation.providerConfigs.MICROSOFT.apiKey).toBe('secret-key');
      expect(userData.settings.translation.providerConfigs.MICROSOFT.apiUrl).toBe(
        'https://api.example.com',
      );
      expect(userData.settings.translation.providerConfigs.MICROSOFT.apiModel).toBe('gpt-4');
    });
  });
});
