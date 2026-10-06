import { BadRequestError } from '../errors/AppError.js';

type NewestCursor = { created_at: string; id: number };

export function encodeCursor(createdAt: string, id: number): string {
    return Buffer.from(JSON.stringify({ created_at: createdAt, id })).toString('base64url');
}

export function decodeCursor(cursor: string): NewestCursor {
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
        if (typeof parsed.created_at !== 'string' || typeof parsed.id !== 'number') {
            throw new BadRequestError('カーソルの形式が不正です');
        }
        return parsed as NewestCursor;
    } catch (e) {
        if (e instanceof BadRequestError) throw e;
        throw new BadRequestError('カーソルの形式が不正です');
    }
}