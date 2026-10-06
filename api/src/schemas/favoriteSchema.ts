import { z } from 'zod';

export const favoriteParamsSchema = z.object({
    id: z.coerce.number().int().positive(), // URL の :id は商品 ID
});

export const getFavoritesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
});