import { Router } from 'express';
import type { Request, Response } from 'express';
import { pool } from '../db/connection.js';

const router = Router();

router.get('/tables', async (_req: Request, res: Response) => {
  const [rows] = await pool.query<any[]>(
    `SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`
  );
  res.json(rows);
});

router.get('/tables/:name/schema', async (req: Request, res: Response) => {
  const [rows] = await pool.query<any[]>(
    `SELECT COLUMN_NAME as column_name, COLUMN_TYPE as column_type, IS_NULLABLE as is_nullable, COLUMN_DEFAULT as column_default, COLUMN_KEY as column_key, EXTRA as extra
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [req.params.name]
  );
  res.json(rows);
});

router.get('/tables/:name/rows', async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const tableName = '`' + req.params.name.replace(/`/g, '') + '`';
  const [[{ total }]] = await pool.query<any[]>(`SELECT COUNT(*) as total FROM ${tableName}`);
  const [rows] = await pool.query<any[]>(`SELECT * FROM ${tableName} LIMIT ? OFFSET ?`, [limit, offset]);

  res.json({ total, page, limit, rows });
});

export default router;
