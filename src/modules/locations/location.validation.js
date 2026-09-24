import { z } from 'zod';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');

export const createLocationSchema = z.object({
  name: z.string().trim().min(1, 'Location is required.').max(150),
});

export const locationIdParamSchema = z.object({ id });
