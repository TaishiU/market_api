import { getEnvironmentData } from "node:worker_threads";
import { pool } from "../db/connection.js";

export const userRepository = {
    // ログインで使用: emailでユーザー検索（password_hashも取得して照合に使う）
    async findByEmail(email: string) {
        const [rows] = await pool.query(
            `SELECT id, email, password_hash, role, status, created_at FROM users WHERE email = ?`,
            [email]
        ) as any[];
        return rows[0] ?? null;
    },

    // 認証済みユーザー情報取得で使用: password_hashはレスポンスに不要のためSELECTしない
    async findById(id: number) {
        const [rows] = await pool.query(
            `SELECT id, email, role, status, created_at FROM users WHERE id = ?`,
            [id]
        ) as any[];
        return rows[0] ?? null;
    },

    // 会員登録で使用: emailとハッシュ済みパスワードをINSERTし、生成されたidを返す
    async craete(email: string, passwordHash: string) {
        const [result] = await pool.query(
            `INSERT INTO users (email, password_hash) VALUES (?, ?)`,
            [email, passwordHash]
        ) as any[];
        return result.insertId as number; // AUTO_INCREMENTで採番された新規ID
    },

    // プロフィール更新で使用:渡されたフィールドだけUPDATEする動的SQL
    async updateById(id: number, fields: {email?:string, passwordHash?: string}) {
        const sets: string[] = []; // SET句の断片（例: ['email = ?', 'password_hash = ?']）
        const values: unknown[] = []; // プレースホルダーに対応する値
        // undefinedでない（実際に渡された）フィールドだけSET句に追加
        if(fields.email !== undefined) {
            sets.push('email = ?');
            values.push(fields.email);
        }
        if(fields.passwordHash !== undefined) {
            sets.push('password_hash = ?');
            values.push(fields.passwordHash);
        }
        if(sets.length === 0) return; // 更新するものがなければ何もしない
        values.push(id); // WHERE id = ?に対応する値を末尾に追加
        // sets.join(', ') → 'email = ?, password_hash = ?'のように結合してSQLを組み立てる
        await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, values);
    },
};

