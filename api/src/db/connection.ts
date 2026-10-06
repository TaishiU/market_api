import mysql from 'mysql2/promise';

const requiredEnv = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'] as const;
for (const key of requiredEnv) {
    if (process.env[key] === undefined) throw new Error(`環境変数 ${key} が設定されていません`);
}

export const pool = mysql.createPool({
    host: process.env.DB_HOST!,
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!,
    waitForConnections: true,
    connectionLimit: 10,
    dateStrings: true, // DATETIME を Date オブジェクトでなく文字列で返す（カーソルのタイムゾーンずれ防止）
});