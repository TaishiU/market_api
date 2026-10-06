import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/connection.js';

const users = [
    {email: 'seller@example.com', password: 'password123', role: 'seller'},
    {email: 'buyer@example.com', password: 'password123', role: 'buyer'},
];

for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await pool.query(
        `INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)`,
        [u.email, hash, u.role]
    );
}

console.log('User seeded');
process.exit(0);