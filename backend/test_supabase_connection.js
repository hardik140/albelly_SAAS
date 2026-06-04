const { Pool } = require('pg');
require('dotenv').config();

console.log("==========================================");
console.log("🔍 SUPABASE / POSTGRES CONNECTIVITY CHECK");
console.log("==========================================");

const dbUrl = process.env.DATABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log(`Supabase URL: ${process.env.SUPABASE_URL || 'Not Set'}`);
console.log(`Anon Public Key: ${anonKey ? (anonKey.includes('placeholder') ? 'Placeholder' : 'Configured') : 'Not Set'}`);
console.log(`Service Role Key: ${serviceKey ? (serviceKey.includes('placeholder') ? 'Placeholder' : 'Configured') : 'Not Set'}`);
console.log(`Database Connection String: ${dbUrl ? (dbUrl.includes('YOUR_PASSWORD_HERE') ? 'Placeholder (needs password)' : 'Configured') : 'Not Set'}`);
console.log("------------------------------------------");

if (!dbUrl || dbUrl.includes('YOUR_PASSWORD_HERE')) {
  console.log("⚠️  NOTICE: PostgreSQL credentials are still set to placeholders.");
  console.log("👉 Please update 'backend/.env' with your real Supabase parameters and database password.");
  process.exit(0);
}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

console.log("Attempting database connection...");

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error("❌ Connection failed!");
    console.error(err.message);
    pool.end();
    process.exit(1);
  } else {
    console.log("✅ Connection SUCCESSFUL!");
    console.log(`Server Time: ${res.rows[0].now}`);
    
    // Check if tables exist
    pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'", (tErr, tRes) => {
      if (tErr) {
        console.error("Could not fetch tables list:", tErr.message);
      } else {
        console.log(`Tables in DB: ${tRes.rows.map(r => r.table_name).join(', ') || 'None (run server to initialize)'}`);
      }
      pool.end();
    });
  }
});
