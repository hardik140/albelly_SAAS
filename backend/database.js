const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: connectionString,
  ssl: connectionString && connectionString.includes('supabase.co') ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle pg client', err);
});

// SQL Translator: translates SQLite query patterns to PostgreSQL
function translateSql(sql) {
  let index = 1;
  let translated = sql.replace(/\?/g, () => `$${index++}`);
  
  // Replace SQLite specific INSERT OR IGNORE / REPLACE patterns
  if (translated.includes('INSERT OR REPLACE INTO settings')) {
    translated = translated.replace('INSERT OR REPLACE INTO settings', 'INSERT INTO settings');
    translated += ' ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';
  }
  
  if (translated.includes('INSERT OR IGNORE INTO settings')) {
    translated = translated.replace('INSERT OR IGNORE INTO settings', 'INSERT INTO settings');
    translated += ' ON CONFLICT (key) DO NOTHING';
  }

  if (translated.includes('INSERT OR IGNORE INTO distributors')) {
    translated = translated.replace('INSERT OR IGNORE INTO distributors', 'INSERT INTO distributors');
    translated += ' ON CONFLICT (name) DO NOTHING';
  }
  
  return translated;
}

// Emulates the sqlite3 Database object API to keep server.js changes minimal
const db = {
  all: (sql, params, callback) => {
    const query = translateSql(sql);
    pool.query(query, params, (err, res) => {
      if (err) {
        callback(err);
      } else {
        callback(null, res.rows);
      }
    });
  },
  get: (sql, params, callback) => {
    const query = translateSql(sql);
    pool.query(query, params, (err, res) => {
      if (err) {
        callback(err);
      } else {
        callback(null, res.rows && res.rows[0] ? res.rows[0] : null);
      }
    });
  },
  run: (sql, params, callback) => {
    let query = translateSql(sql);
    const isInsert = query.trim().toUpperCase().startsWith('INSERT');
    if (isInsert && !query.toUpperCase().includes('RETURNING')) {
      query += ' RETURNING id';
    }
    pool.query(query, params, (err, res) => {
      if (err) {
        callback(err);
      } else {
        const lastID = res.rows && res.rows[0] ? res.rows[0].id : null;
        const context = {
          lastID: lastID,
          changes: res.rowCount
        };
        callback.call(context, null);
      }
    });
  }
};

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Raw Materials Table
    await client.query(`CREATE TABLE IF NOT EXISTS raw_materials (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      SKU TEXT NOT NULL UNIQUE,
      current_stock REAL NOT NULL DEFAULT 0.0,
      unit TEXT NOT NULL,
      capacity REAL NOT NULL DEFAULT 100.0,
      safety REAL NOT NULL DEFAULT 20.0
    )`);

    // 2. Inventory Batches
    await client.query(`CREATE TABLE IF NOT EXISTS inventory_batches (
      id SERIAL PRIMARY KEY,
      raw_material_id INTEGER NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
      batch_number TEXT NOT NULL,
      quantity_received REAL NOT NULL,
      remaining_quantity REAL NOT NULL,
      unit_price REAL NOT NULL DEFAULT 0.0,
      received_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expiry_date TIMESTAMP NOT NULL
    )`);

    // 3. Recipes Table
    await client.query(`CREATE TABLE IF NOT EXISTS recipes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      yield_quantity REAL NOT NULL,
      yield_unit TEXT NOT NULL
    )`);

    // 4. Recipe Ingredients Table
    await client.query(`CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id SERIAL PRIMARY KEY,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      raw_material_id INTEGER NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
      quantity_required REAL NOT NULL
    )`);

    // 5. Production Batches
    await client.query(`CREATE TABLE IF NOT EXISTS production_batches (
      id SERIAL PRIMARY KEY,
      batch_code TEXT NOT NULL UNIQUE,
      recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
      flavor_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('MIXING', 'AGING', 'CHURNING_FREEZING', 'HARDENING', 'COMPLETED', 'FAILED')),
      quantity_produced REAL DEFAULT 0.0,
      start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      aging_end_time TIMESTAMP,
      expiry_date TIMESTAMP
    )`);

    // 6. Batch Ingredients (Traceability Link)
    await client.query(`CREATE TABLE IF NOT EXISTS batch_ingredients (
      id SERIAL PRIMARY KEY,
      production_batch_id INTEGER NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
      raw_material_id INTEGER NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
      inventory_batch_id INTEGER NOT NULL REFERENCES inventory_batches(id) ON DELETE CASCADE,
      quantity_used REAL NOT NULL
    )`);

    // 7. Gate Logs (In-Out Manager)
    await client.query(`CREATE TABLE IF NOT EXISTS gate_logs (
      id SERIAL PRIMARY KEY,
      vehicle_number TEXT NOT NULL,
      driver_name TEXT NOT NULL,
      purpose TEXT NOT NULL,
      time_in TIMESTAMP NOT NULL,
      time_out TIMESTAMP
    )`);

    // 8. Orders Table
    await client.query(`CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_code TEXT NOT NULL UNIQUE,
      customer_name TEXT NOT NULL,
      order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      total_amount REAL NOT NULL,
      tax_amount REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'DISPATCHED', 'COMPLETED')),
      gst_rate REAL NOT NULL DEFAULT 0.18,
      customer_location TEXT,
      customer_gstin TEXT,
      payment_status TEXT
    )`);

    // 9. Order Items Table
    await client.query(`CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL
    )`);

    // 10. Audit Trails
    await client.query(`CREATE TABLE IF NOT EXISTS audit_trails (
      id SERIAL PRIMARY KEY,
      user_role TEXT NOT NULL,
      user_name TEXT NOT NULL,
      action TEXT NOT NULL,
      table_name TEXT NOT NULL,
      record_id INTEGER,
      old_value TEXT,
      new_value TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // 11. Finished Goods Stock
    await client.query(`CREATE TABLE IF NOT EXISTS finished_goods (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      SKU TEXT NOT NULL UNIQUE,
      price REAL NOT NULL,
      stock_qty INTEGER NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'pcs'
    )`);

    // 12. Settings Table
    await client.query(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    await client.query(`INSERT INTO settings (key, value) VALUES ('gst_rate', '0.18') ON CONFLICT (key) DO NOTHING`);

    // 13. Distributors Table
    await client.query(`CREATE TABLE IF NOT EXISTS distributors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      location TEXT,
      gstin TEXT,
      phone TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Seed standard distributors
    const seedDists = [
      ['Deluxe Distributors', 'Bengaluru'],
      ['Joy Ice Cream Parlour', 'Mumbai'],
      ['Apex Cold Foods', 'Delhi'],
      ['Creamy Delight Inc', 'Chennai'],
      ['National Food Service', 'Kolkata']
    ];
    for (const [name, loc] of seedDists) {
      await client.query(`INSERT INTO distributors (name, location) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [name, loc]);
      await client.query(`UPDATE distributors SET location = $1 WHERE name = $2 AND (location IS NULL OR location = '')`, [loc, name]);
    }

    // 14. User Roles Table (to manage Auth roles link)
    await client.query(`CREATE TABLE IF NOT EXISTS user_roles (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL UNIQUE,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'INVENTORY_MANAGER', 'PRODUCTION_SUPERVISOR', 'SALES_AGENT')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // 15. Workers Table
    await client.query(`CREATE TABLE IF NOT EXISTS workers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      hourly_rate REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // 16. Worker Shifts Table
    await client.query(`CREATE TABLE IF NOT EXISTS worker_shifts (
      id SERIAL PRIMARY KEY,
      worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      time_in TIMESTAMP WITH TIME ZONE NOT NULL,
      time_out TIMESTAMP WITH TIME ZONE,
      hourly_rate REAL NOT NULL,
      total_hours REAL,
      payment_amount REAL,
      is_paid BOOLEAN NOT NULL DEFAULT FALSE
    )`);

    // 17. Create Performance Indices for highly optimized queries
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_batches_raw_material_expiry 
      ON inventory_batches (raw_material_id, expiry_date, remaining_quantity)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order_id 
      ON order_items (order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_customer_name_date 
      ON orders (customer_name, order_date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe_id 
      ON recipe_ingredients (recipe_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_production_batches_flavor_status 
      ON production_batches (flavor_name, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_worker_shifts_worker_id 
      ON worker_shifts (worker_id)`);

    await client.query('COMMIT');
    console.log('PostgreSQL database tables verified and initialized successfully.');
    
    // Seed database if empty
    const rawCountRes = await client.query('SELECT COUNT(*) as count FROM raw_materials');
    const rawCount = parseInt(rawCountRes.rows[0].count);
    if (rawCount === 0) {
      await seedDatabase();
    } else {
      await seedHistoricalData();
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error initializing PostgreSQL tables:', e);
    throw e;
  } finally {
    client.release();
  }
}

async function logAudit(userRole, userName, action, tableName, recordId, oldValue, newValue) {
  try {
    const query = `INSERT INTO audit_trails (user_role, user_name, action, table_name, record_id, old_value, new_value)
                   VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;
    const res = await pool.query(query, [
      userRole,
      userName,
      action,
      tableName,
      recordId,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null
    ]);
    return res.rows[0].id;
  } catch (err) {
    console.error('Audit logging failed:', err);
    throw err;
  }
}

async function seedDatabase() {
  console.log("Seeding fresh database with sample ice cream factory data...");
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const milkRes = await client.query("INSERT INTO raw_materials (name, SKU, current_stock, unit, capacity, safety) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", ["Raw Milk", "RM-MILK-01", 1250.0, "L", 2000.0, 500.0]);
    const milkId = milkRes.rows[0].id;
    
    const creamRes = await client.query("INSERT INTO raw_materials (name, SKU, current_stock, unit, capacity, safety) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", ["Fresh Cream", "RM-CREAM-02", 680.0, "L", 1000.0, 200.0]);
    const creamId = creamRes.rows[0].id;
    
    const sugarRes = await client.query("INSERT INTO raw_materials (name, SKU, current_stock, unit, capacity, safety) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", ["Granulated Sugar", "RM-SUGAR-03", 450.0, "kg", 500.0, 100.0]);
    const sugarId = sugarRes.rows[0].id;
    
    const vanillaRes = await client.query("INSERT INTO raw_materials (name, SKU, current_stock, unit, capacity, safety) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", ["Vanilla Extract", "RM-VAN-04", 45.0, "L", 50.0, 10.0]);
    const vanillaId = vanillaRes.rows[0].id;
    
    const cocoaRes = await client.query("INSERT INTO raw_materials (name, SKU, current_stock, unit, capacity, safety) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", ["Cocoa Powder", "RM-COCOA-05", 85.0, "kg", 100.0, 20.0]);
    const cocoaId = cocoaRes.rows[0].id;
    
    const stabRes = await client.query("INSERT INTO raw_materials (name, SKU, current_stock, unit, capacity, safety) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", ["Stabilizer SE-7", "RM-STAB-06", 25.0, "kg", 50.0, 10.0]);
    const stabId = stabRes.rows[0].id;

    const now = new Date();
    const formatTime = (d) => d.toISOString().replace('T', ' ').substring(0, 19);

    // Milk batches
    const dateExpired = new Date(now.getTime() - 24 * 60 * 60 * 1000 * 2);
    await client.query("INSERT INTO inventory_batches (raw_material_id, batch_number, quantity_received, remaining_quantity, unit_price, expiry_date) VALUES ($1, $2, $3, $4, $5, $6)", 
      [milkId, "BAT-MILK-EXP", 200, 200, 40.0, formatTime(dateExpired)]);

    const dateNearExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000 * 2.5);
    await client.query("INSERT INTO inventory_batches (raw_material_id, batch_number, quantity_received, remaining_quantity, unit_price, expiry_date) VALUES ($1, $2, $3, $4, $5, $6)", 
      [milkId, "BAT-MILK-NEAR", 500, 500, 42.0, formatTime(dateNearExpiry)]);

    const dateFreshMilk = new Date(now.getTime() + 24 * 60 * 60 * 1000 * 12);
    await client.query("INSERT INTO inventory_batches (raw_material_id, batch_number, quantity_received, remaining_quantity, unit_price, expiry_date) VALUES ($1, $2, $3, $4, $5, $6)", 
      [milkId, "BAT-MILK-FRESH", 550, 550, 39.5, formatTime(dateFreshMilk)]);

    // Cream batches
    const dateNearCream = new Date(now.getTime() + 24 * 60 * 60 * 1000 * 3.5);
    await client.query("INSERT INTO inventory_batches (raw_material_id, batch_number, quantity_received, remaining_quantity, unit_price, expiry_date) VALUES ($1, $2, $3, $4, $5, $6)", 
      [creamId, "BAT-CRM-001", 300, 300, 85.0, formatTime(dateNearCream)]);
    const dateFreshCream = new Date(now.getTime() + 24 * 60 * 60 * 1000 * 15);
    await client.query("INSERT INTO inventory_batches (raw_material_id, batch_number, quantity_received, remaining_quantity, unit_price, expiry_date) VALUES ($1, $2, $3, $4, $5, $6)", 
      [creamId, "BAT-CRM-002", 380, 380, 80.0, formatTime(dateFreshCream)]);

    // Other goods (longer expiry)
    const dateSugar = new Date(now.getTime() + 24 * 60 * 60 * 1000 * 180);
    await client.query("INSERT INTO inventory_batches (raw_material_id, batch_number, quantity_received, remaining_quantity, unit_price, expiry_date) VALUES ($1, $2, $3, $4, $5, $6)", 
      [sugarId, "BAT-SUG-01", 450, 450, 60.0, formatTime(dateSugar)]);
    
    const dateVan = new Date(now.getTime() + 24 * 60 * 60 * 1000 * 365);
    await client.query("INSERT INTO inventory_batches (raw_material_id, batch_number, quantity_received, remaining_quantity, unit_price, expiry_date) VALUES ($1, $2, $3, $4, $5, $6)", 
      [vanillaId, "BAT-VAN-01", 45, 45, 450.0, formatTime(dateVan)]);

    const dateCocoa = new Date(now.getTime() + 24 * 60 * 60 * 1000 * 200);
    await client.query("INSERT INTO inventory_batches (raw_material_id, batch_number, quantity_received, remaining_quantity, unit_price, expiry_date) VALUES ($1, $2, $3, $4, $5, $6)", 
      [cocoaId, "BAT-COCOA-01", 85, 85, 300.0, formatTime(dateCocoa)]);

    const dateStab = new Date(now.getTime() + 24 * 60 * 60 * 1000 * 90);
    await client.query("INSERT INTO inventory_batches (raw_material_id, batch_number, quantity_received, remaining_quantity, unit_price, expiry_date) VALUES ($1, $2, $3, $4, $5, $6)", 
      [stabId, "BAT-STAB-01", 25, 25, 200.0, formatTime(dateStab)]);

    // Seed Recipes
    const rVanillaRes = await client.query("INSERT INTO recipes (name, yield_quantity, yield_unit) VALUES ($1, $2, $3) RETURNING id", ["Vanilla 1L Brick", 100, "pcs"]);
    const rVanillaId = rVanillaRes.rows[0].id;
    await client.query("INSERT INTO recipe_ingredients (recipe_id, raw_material_id, quantity_required) VALUES ($1, $2, $3)", [rVanillaId, milkId, 80.0]);
    await client.query("INSERT INTO recipe_ingredients (recipe_id, raw_material_id, quantity_required) VALUES ($1, $2, $3)", [rVanillaId, creamId, 20.0]);
    await client.query("INSERT INTO recipe_ingredients (recipe_id, raw_material_id, quantity_required) VALUES ($1, $2, $3)", [rVanillaId, sugarId, 10.0]);
    await client.query("INSERT INTO recipe_ingredients (recipe_id, raw_material_id, quantity_required) VALUES ($1, $2, $3)", [rVanillaId, vanillaId, 1.5]);
    await client.query("INSERT INTO recipe_ingredients (recipe_id, raw_material_id, quantity_required) VALUES ($1, $2, $3)", [rVanillaId, stabId, 0.5]);

    const rChocoRes = await client.query("INSERT INTO recipes (name, yield_quantity, yield_unit) VALUES ($1, $2, $3) RETURNING id", ["Choco Cone 100ml", 500, "pcs"]);
    const rChocoId = rChocoRes.rows[0].id;
    await client.query("INSERT INTO recipe_ingredients (recipe_id, raw_material_id, quantity_required) VALUES ($1, $2, $3)", [rChocoId, milkId, 50.0]);
    await client.query("INSERT INTO recipe_ingredients (recipe_id, raw_material_id, quantity_required) VALUES ($1, $2, $3)", [rChocoId, creamId, 15.0]);
    await client.query("INSERT INTO recipe_ingredients (recipe_id, raw_material_id, quantity_required) VALUES ($1, $2, $3)", [rChocoId, sugarId, 8.0]);
    await client.query("INSERT INTO recipe_ingredients (recipe_id, raw_material_id, quantity_required) VALUES ($1, $2, $3)", [rChocoId, cocoaId, 6.0]);
    await client.query("INSERT INTO recipe_ingredients (recipe_id, raw_material_id, quantity_required) VALUES ($1, $2, $3)", [rChocoId, stabId, 0.4]);

    // Seed Finished Goods
    await client.query("INSERT INTO finished_goods (name, SKU, price, stock_qty) VALUES ($1, $2, $3, $4)", ["Vanilla 1L Brick", "FG-VAN-BRICK", 5.00, 120]);
    await client.query("INSERT INTO finished_goods (name, SKU, price, stock_qty) VALUES ($1, $2, $3, $4)", ["Choco Cone 100ml", "FG-CHO-CONE", 1.00, 450]);
    await client.query("INSERT INTO finished_goods (name, SKU, price, stock_qty) VALUES ($1, $2, $3, $4)", ["Mango Tub 5L", "FG-MAN-TUB", 22.00, 14]);

    // Seed active and past Production Batches
    const pb1Res = await client.query("INSERT INTO production_batches (batch_code, recipe_id, flavor_name, status, quantity_produced) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      ["PB-26-001", rVanillaId, "Vanilla 1L Brick", "MIXING", 0]);
    const pb1Id = pb1Res.rows[0].id;
    await client.query("INSERT INTO batch_ingredients (production_batch_id, raw_material_id, inventory_batch_id, quantity_used) VALUES ($1, $2, $3, $4)", [pb1Id, milkId, 2, 80.0]); // BAT-MILK-NEAR has ID 2

    const agingEnd = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const pb2Res = await client.query("INSERT INTO production_batches (batch_code, recipe_id, flavor_name, status, aging_end_time, quantity_produced) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      ["PB-26-002", rVanillaId, "Vanilla 1L Brick", "AGING", formatTime(agingEnd), 0]);
    const pb2Id = pb2Res.rows[0].id;
    await client.query("INSERT INTO batch_ingredients (production_batch_id, raw_material_id, inventory_batch_id, quantity_used) VALUES ($1, $2, $3, $4)", [pb2Id, milkId, 2, 80.0]);
    await client.query("INSERT INTO batch_ingredients (production_batch_id, raw_material_id, inventory_batch_id, quantity_used) VALUES ($1, $2, $3, $4)", [pb2Id, creamId, 4, 20.0]); // BAT-CRM-001 has ID 4

    const expiryFinished = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const pb3Res = await client.query("INSERT INTO production_batches (batch_code, recipe_id, flavor_name, status, quantity_produced, expiry_date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      ["PB-26-003", rVanillaId, "Vanilla 1L Brick", "COMPLETED", 100, formatTime(expiryFinished)]);
    const pb3Id = pb3Res.rows[0].id;
    await client.query("INSERT INTO batch_ingredients (production_batch_id, raw_material_id, inventory_batch_id, quantity_used) VALUES ($1, $2, $3, $4)", [pb3Id, milkId, 2, 80.0]);
    await client.query("INSERT INTO batch_ingredients (production_batch_id, raw_material_id, inventory_batch_id, quantity_used) VALUES ($1, $2, $3, $4)", [pb3Id, creamId, 4, 20.0]);

    // Seed Gate Logs
    const inTime1 = new Date(now.getTime() - 45 * 60 * 1000);
    await client.query("INSERT INTO gate_logs (vehicle_number, driver_name, purpose, time_in) VALUES ($1, $2, $3, $4)",
      ["KA-03-ME-9812", "Ramesh Kumar", "Raw Material Delivery (Milk)", formatTime(inTime1)]);

    const inTime2 = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const outTime2 = new Date(now.getTime() - 30 * 60 * 1000);
    await client.query("INSERT INTO gate_logs (vehicle_number, driver_name, purpose, time_in, time_out) VALUES ($1, $2, $3, $4, $5)",
      ["DL-01-A-4432", "Sukhwinder Singh", "Sales Dispatch Order #1002", formatTime(inTime2), formatTime(outTime2)]);

    const inTime3 = new Date(now.getTime() - 10 * 60 * 1000);
    await client.query("INSERT INTO gate_logs (vehicle_number, driver_name, purpose, time_in) VALUES ($1, $2, $3, $4)",
      ["MH-12-PQ-0098", "Ajit Shinde", "Sales Dispatch Order #1003", formatTime(inTime3)]);

    // Seed Orders
    const orderId1Res = await client.query("INSERT INTO orders (order_code, customer_name, total_amount, tax_amount, status, gst_rate) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      ["ORD-1002", "Deluxe Distributors", 115.00, 15.00, "COMPLETED", 0.15]);
    const orderId1 = orderId1Res.rows[0].id;
    await client.query("INSERT INTO order_items (order_id, product_name, quantity, price) VALUES ($1, $2, $3, $4)",
      [orderId1, "Vanilla 1L Brick", 20, 5.00]);

    const orderId2Res = await client.query("INSERT INTO orders (order_code, customer_name, total_amount, tax_amount, status, gst_rate) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      ["ORD-1003", "Joy Ice Cream Parlour", 57.50, 7.50, "PENDING", 0.15]);
    const orderId2 = orderId2Res.rows[0].id;
    await client.query("INSERT INTO order_items (order_id, product_name, quantity, price) VALUES ($1, $2, $3, $4)",
      [orderId2, "Choco Cone 100ml", 50, 1.00]);

    await client.query('COMMIT');
    console.log("Database seeded successfully!");
    
    await seedHistoricalData();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Failed to seed database:", err);
    throw err;
  } finally {
    client.release();
  }
}

async function seedHistoricalData() {
  const checkRes = await pool.query("SELECT COUNT(*) as count FROM orders");
  const count = parseInt(checkRes.rows[0].count);
  if (count > 5) {
    console.log("Historical orders already seeded.");
    return;
  }

  console.log("Seeding historical orders and production batches for dashboard charts...");
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const now = new Date();
    const customers = ["Deluxe Distributors", "Joy Ice Cream Parlour", "Apex Cold Foods", "Creamy Delight Inc", "National Food Service"];
    const products = [
      { name: "Vanilla 1L Brick", SKU: "FG-VAN-BRICK", price: 5.00, recipeId: 1, yield: 100 },
      { name: "Choco Cone 100ml", SKU: "FG-CHO-CONE", price: 1.00, recipeId: 2, yield: 500 },
      { name: "Mango Tub 5L", SKU: "FG-MAN-TUB", price: 22.00, recipeId: null, yield: 10 }
    ];

    const formatTime = (d) => d.toISOString().replace('T', ' ').substring(0, 19);

    for (let i = 11; i >= 0; i--) {
      const numOrders = Math.floor(Math.random() * 6) + 6;
      for (let o = 0; o < numOrders; o++) {
        const day = Math.floor(Math.random() * 27) + 1;
        const hour = Math.floor(Math.random() * 11) + 8;
        const minute = Math.floor(Math.random() * 60);
        const orderDate = new Date(now.getFullYear(), now.getMonth() - i, day, hour, minute);
        const dateStr = formatTime(orderDate);
        const customer = customers[Math.floor(Math.random() * customers.length)];
        const orderCode = `ORD-${orderDate.getFullYear()}${(orderDate.getMonth()+1).toString().padStart(2,'0')}-${Math.floor(1000 + Math.random() * 9000)}`;

        const numItems = Math.floor(Math.random() * 3) + 1;
        const items = [];
        let subtotal = 0;
        const shuffledProducts = [...products].sort(() => 0.5 - Math.random());
        for (let k = 0; k < numItems; k++) {
          const prod = shuffledProducts[k];
          const quantity = Math.floor(Math.random() * 30) + 5;
          const cost = prod.price * quantity;
          subtotal += cost;
          items.push({ name: prod.name, quantity, price: prod.price });
        }

        const tax = subtotal * 0.18;
        const total = subtotal + tax;

        const orderRes = await client.query(
          "INSERT INTO orders (order_code, customer_name, order_date, total_amount, tax_amount, status, gst_rate) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
          [orderCode, customer, dateStr, total, tax, 'COMPLETED', 0.18]
        );
        const orderId = orderRes.rows[0].id;

        for (const item of items) {
          await client.query(
            "INSERT INTO order_items (order_id, product_name, quantity, price) VALUES ($1, $2, $3, $4)",
            [orderId, item.name, item.quantity, item.price]
          );
        }
      }

      const numBatches = Math.floor(Math.random() * 4) + 4;
      for (let pb = 0; pb < numBatches; pb++) {
        const day = Math.floor(Math.random() * 27) + 1;
        const hour = Math.floor(Math.random() * 11) + 8;
        const minute = Math.floor(Math.random() * 60);
        const prodDate = new Date(now.getFullYear(), now.getMonth() - i, day, hour, minute);
        const dateStr = formatTime(prodDate);
        
        const recipe = products[Math.floor(Math.random() * 2)];
        const batchCode = `PB-${prodDate.getFullYear().toString().slice(-2)}${(prodDate.getMonth()+1).toString().padStart(2,'0')}-${Math.floor(100 + Math.random() * 900)}`;

        const expiryFinished = new Date(prodDate.getTime() + 90 * 24 * 60 * 60 * 1000);
        const expDateStr = formatTime(expiryFinished);

        await client.query(
          "INSERT INTO production_batches (batch_code, recipe_id, flavor_name, status, quantity_produced, start_time, expiry_date) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [batchCode, recipe.recipeId, recipe.name, 'COMPLETED', recipe.yield, dateStr, expDateStr]
        );
      }
    }
    await client.query('COMMIT');
    console.log("Historical orders and production batches seeded successfully!");
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Error seeding historical data:", err);
  } finally {
    client.release();
  }
}

module.exports = {
  db,
  initDb,
  logAudit,
  pool
};
