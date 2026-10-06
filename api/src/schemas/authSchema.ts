import {email, z} from 'zod';

export const registerSchema = z.object({
    email: z.email(),
    password: z.string().min(8),
});


export const loginSchema = z.object({
    email: z.email(),
    password: z.string().min(1),
});

export const updateProfileSchema = z.object({
    email: z.email().optional(),
    password: z.string().min(8).optional(),
});

