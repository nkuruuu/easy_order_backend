import 'dotenv/config';
import mysql from 'mysql2/promise';

// 1. Determine the database target string
// If MYSQL_URL exists (on Railway), use it. Otherwise, fall back to a local string constructed from individual variables.
const connectionString = process.env.MYSQL_URL || {
  uri: `mysql://${process.env.DB_USER || 'root'}:${process.env.DB_PASS || ''}@${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME || 'easy_order'}`
};

// 2. Create the configuration object
const poolConfig = typeof connectionString === 'string' 
  ? { uri: connectionString } 
  : connectionString;

// 3. Instantiate the connection pool
export const pool = mysql.createPool({
  ...poolConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});
