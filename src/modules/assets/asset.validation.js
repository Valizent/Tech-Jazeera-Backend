/**
 * Zod schemas for the Asset module.
 */
import { z } from 'zod';
import { ASSET_CATEGORIES, ASSET_STATUSES } from './asset.model.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const createAssetSchema = z.object({
  assetTag: z.string().trim().min(1, 'Asset tag is required.').max(30),
  name: z.string().trim().min(1, 'Name is required.').max(200),
  category: z.enum(ASSET_CATEGORIES, { error: 'Choose a category.' }),
  purchaseDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
  notes: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
});

export const updateAssetSchema = z.object({
  assetTag: z.string().trim().min(1).max(30).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  category: z.enum(ASSET_CATEGORIES).optional(),
  purchaseDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
  notes: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
});

/** Direct status changes when NOT currently assigned (Available <-> Maintenance/Retired). */
export const setAssetStatusSchema = z.object({
  status: z.enum(['Available', 'Maintenance', 'Retired'], { error: 'Choose a status.' }),
});

export const assignAssetSchema = z.object({
  employee: id,
  assignedAt: z.preprocess(emptyToUndef, z.coerce.date().optional()),
  notes: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
});

export const returnAssetSchema = z.object({
  conditionNote: z.preprocess(emptyToUndef, z.string().trim().max(300).optional()),
  notes: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
});

export const listAssetsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  category: z.preprocess(emptyToUndef, z.enum(ASSET_CATEGORIES).optional()),
  status: z.preprocess(emptyToUndef, z.enum(ASSET_STATUSES).optional()),
  search: z.preprocess(emptyToUndef, z.string().trim().max(100).optional()),
});

export const assetIdParamSchema = z.object({ id });
export const employeeIdParamSchema = z.object({ employeeId: id });
