import 'dotenv/config';
import mysql from 'mysql2/promise';

const mysqlUrl = process.env.MYSQL_URL;
const host = process.env.MYSQLHOST || process.env.MYSQL_HOST || process.env.DB_HOST;
const port = process.env.MYSQLPORT || process.env.MYSQL_PORT || process.env.DB_PORT || 3306;
const user = process.env.MYSQLUSER || process.env.MYSQL_USER || process.env.DB_USER;
const password = process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || process.env.DB_PASS || '';
const database = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || process.env.DB_NAME;

if (!mysqlUrl && (!host || !user || !database)) {
  throw new Error('Database configuration missing. Set MYSQL_URL or MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD, and MYSQLDATABASE.');
}

const connectionString = mysqlUrl || {
  uri: `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`
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
