require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { db, initDb, logAudit } = require('./database');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// JWT Token Authentication Middleware via Supabase
const authenticateJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://mqkaatsydqiaksjeesdi.supabase.co';
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseAnonKey || supabaseAnonKey.includes('anon_public_key')) {
      // If keys are not configured yet, skip verification to allow testing setup
      return next();
    }

    const verifyRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': supabaseAnonKey
      }
    });

    if (!verifyRes.ok) {
      return res.status(401).json({ error: 'Unauthorized: Invalid Supabase token' });
    }

    const userData = await verifyRes.json();
    
    // Fetch associated user role from postgres user_roles table
    const userRoleRecord = await new Promise((resolve) => {
      db.get("SELECT role FROM user_roles WHERE user_id = ?", [userData.id], (err, row) => {
        resolve(row);
      });
    });

    const role = userRoleRecord ? userRoleRecord.role : 'SALES_AGENT';
    const name = userData.user_metadata?.full_name || userData.email;

    req.user = {
      id: userData.id,
      email: userData.email,
      name,
      role
    };

    // Override request body role and name parameters for audit logging compatibility
    if (req.body) {
      req.body.user_role = role;
      req.body.user_name = name;
    }

    next();
  } catch (err) {
    console.error('JWT verification error:', err);
    res.status(500).json({ error: 'Internal Auth Error: ' + err.message });
  }
};

app.use(authenticateJWT);

// Authenticated current user profile endpoint
app.get('/api/v1/auth/me', (req, res) => {
  if (req.user) {
    res.json(req.user);
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Endpoint to map signed-up user ID to a database role
app.post('/api/v1/auth/register-role', async (req, res) => {
  const { userId, email, role } = req.body;
  if (!userId || !email || !role) {
    return res.status(400).json({ error: 'Missing required parameters: userId, email, role' });
  }

  if (!['ADMIN', 'INVENTORY_MANAGER', 'PRODUCTION_SUPERVISOR', 'SALES_AGENT'].includes(role)) {
    return res.status(400).json({ error: 'Invalid user role' });
  }

  try {
    const existing = await new Promise((resolve) => {
      db.get("SELECT * FROM user_roles WHERE user_id = ?", [userId], (err, row) => {
        resolve(row);
      });
    });

    if (existing) {
      await new Promise((resolve, reject) => {
        db.run("UPDATE user_roles SET role = ? WHERE user_id = ?", [role, userId], (err) => {
          if (err) reject(err); else resolve();
        });
      });
    } else {
      await new Promise((resolve, reject) => {
        db.run("INSERT INTO user_roles (user_id, email, role) VALUES (?, ?, ?)", [userId, email, role], (err) => {
          if (err) reject(err); else resolve();
        });
      });
    }

    res.json({ success: true, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Broadcast helper for WebSocket updates
function broadcast(event, data) {
  const payload = JSON.stringify({ event, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('New WebSocket client connected');
  ws.send(JSON.stringify({ event: 'WELCOME', data: 'Connected to Stitch Real-Time ERP Server' }));
});

// Helper: Query all as Promise
const dbAll = (sql, params = []) => new Promise((res, rej) => {
  db.all(sql, params, (err, rows) => {
    if (err) rej(err); else res(rows);
  });
});

// Helper: Query one as Promise
const dbGet = (sql, params = []) => new Promise((res, rej) => {
  db.get(sql, params, (err, row) => {
    if (err) rej(err); else res(row);
  });
});

// Helper: Run command as Promise
const dbRun = (sql, params = []) => new Promise((res, rej) => {
  db.run(sql, params, function(err) {
    if (err) rej(err); else res(this);
  });
});

// ==========================================
// ⚙️ SETTINGS API
// ==========================================

// GET settings
app.get('/api/v1/settings', async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM settings");
    const settings = {};
    rows.forEach(r => {
      const val = parseFloat(r.value);
      settings[r.key] = isNaN(val) ? r.value : val;
    });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT settings (restricted to Admin/Owner role)
app.put('/api/v1/settings', async (req, res) => {
  const { key, value, user_role, user_name } = req.body;
  if (!key || value === undefined) {
    return res.status(400).json({ error: "key and value are required" });
  }

  const role = user_role || "ADMIN";
  if (role !== "ADMIN") {
    return res.status(403).json({ error: "Access denied. Admin role required." });
  }

  try {
    const existing = await dbGet("SELECT * FROM settings WHERE key = ?", [key]);
    await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, value.toString()]);

    // Log Audit
    await logAudit(
      role,
      user_name || "Manager",
      "SETTING_CHANGED",
      "settings",
      null,
      existing ? { value: existing.value } : null,
      { key, value: value.toString() }
    );

    broadcast("SETTINGS_UPDATED", { key, value });
    res.json({ success: true, key, value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 📦 INVENTORY API
// ==========================================

// GET Raw Materials + Batches
app.get('/api/v1/inventory/raw-materials', async (req, res) => {
  try {
    const rawMaterials = await dbAll("SELECT * FROM raw_materials");
    const batches = await dbAll(`
      SELECT b.*, m.name as material_name, m.unit 
      FROM inventory_batches b
      JOIN raw_materials m ON b.raw_material_id = m.id
      ORDER BY expiry_date ASC
    `);
    res.json({ rawMaterials, batches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Add Raw stock with Expiry
app.post('/api/v1/inventory/raw-materials', async (req, res) => {
  const { name, SKU, unit, quantity, expiry_date, capacity, safety, user_role, user_name } = req.body;
  if (!name || !SKU || !unit || quantity === undefined || !expiry_date) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // 1. Find or create raw material
    let rawMaterial = await dbGet("SELECT * FROM raw_materials WHERE SKU = ?", [SKU]);
    let rawMaterialId;
    if (rawMaterial) {
      rawMaterialId = rawMaterial.id;
      const newStock = rawMaterial.current_stock + parseFloat(quantity);
      const cap = capacity !== undefined ? parseFloat(capacity) : rawMaterial.capacity;
      const saf = safety !== undefined ? parseFloat(safety) : rawMaterial.safety;
      await dbRun("UPDATE raw_materials SET current_stock = ?, capacity = ?, safety = ? WHERE id = ?", [newStock, cap, saf, rawMaterialId]);
    } else {
      const cap = capacity !== undefined ? parseFloat(capacity) : 100.0;
      const saf = safety !== undefined ? parseFloat(safety) : 20.0;
      const result = await dbRun("INSERT INTO raw_materials (name, SKU, current_stock, unit, capacity, safety) VALUES (?, ?, ?, ?, ?, ?)", [name, SKU, parseFloat(quantity), unit, cap, saf]);
      rawMaterialId = result.lastID;
    }

    // 2. Create new inventory batch
    const batchNumber = `BAT-${SKU}-${Date.now().toString().slice(-4)}`;
    const expiryTimestamp = expiry_date.includes(' ') ? expiry_date : `${expiry_date} 00:00:00`;
    await dbRun(`INSERT INTO inventory_batches (raw_material_id, batch_number, quantity_received, remaining_quantity, expiry_date) 
                 VALUES (?, ?, ?, ?, ?)`, [rawMaterialId, batchNumber, parseFloat(quantity), parseFloat(quantity), expiryTimestamp]);

    // 3. Log Audit
    await logAudit(
      user_role || "INVENTORY_MANAGER",
      user_name || "Manager",
      "STOCK_INCREMENT",
      "inventory_batches",
      rawMaterialId,
      rawMaterial ? { current_stock: rawMaterial.current_stock } : null,
      { current_stock: (rawMaterial ? rawMaterial.current_stock : 0) + parseFloat(quantity), new_batch: batchNumber }
    );

    // Broadcast update
    broadcast("INVENTORY_UPDATED", { SKU, added: quantity });
    res.json({ success: true, batchNumber });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE Raw Material (Discontinue)
app.delete('/api/v1/inventory/raw-materials/:id', async (req, res) => {
  const { id } = req.params;
  const { user_role, user_name } = req.body;
  
  try {
    const rawMaterial = await dbGet("SELECT * FROM raw_materials WHERE id = ?", [id]);
    if (!rawMaterial) {
      return res.status(404).json({ error: "Raw material not found" });
    }

    // 1. Delete associated inventory batches
    await dbRun("DELETE FROM inventory_batches WHERE raw_material_id = ?", [id]);
    
    // 2. Delete raw material
    await dbRun("DELETE FROM raw_materials WHERE id = ?", [id]);

    // 3. Log Audit
    await logAudit(
      user_role || "ADMIN",
      user_name || "Manager",
      "MATERIAL_DISCONTINUED",
      "raw_materials",
      id,
      { name: rawMaterial.name, SKU: rawMaterial.SKU, current_stock: rawMaterial.current_stock },
      null
    );

    // Broadcast update
    broadcast("INVENTORY_UPDATED", { SKU: rawMaterial.SKU, deleted: true });
    res.json({ success: true, message: `Discontinued raw material ${rawMaterial.name} successfully.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE Raw Material Batch
app.delete('/api/v1/inventory/batches/:id', async (req, res) => {
  const { id } = req.params;
  const { user_role, user_name } = req.body;
  try {
    const batch = await dbGet("SELECT * FROM inventory_batches WHERE id = ?", [id]);
    if (!batch) {
      return res.status(404).json({ error: "Batch not found" });
    }
    const rawMaterial = await dbGet("SELECT * FROM raw_materials WHERE id = ?", [batch.raw_material_id]);
    if (rawMaterial) {
      const newStock = Math.max(0, rawMaterial.current_stock - batch.remaining_quantity);
      await dbRun("UPDATE raw_materials SET current_stock = ? WHERE id = ?", [newStock, batch.raw_material_id]);
    }
    await dbRun("DELETE FROM inventory_batches WHERE id = ?", [id]);
    await logAudit(
      user_role || "INVENTORY_MANAGER",
      user_name || "Manager",
      "BATCH_DELETED",
      "inventory_batches",
      id,
      { batch_number: batch.batch_number, remaining_quantity: batch.remaining_quantity },
      null
    );
    broadcast("INVENTORY_UPDATED", { SKU: rawMaterial ? rawMaterial.SKU : null, deleted_batch: batch.batch_number });
    res.json({ success: true, message: `Deleted batch ${batch.batch_number} successfully.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🍦 RECIPES API
// ==========================================

// GET Recipes
app.get('/api/v1/recipes', async (req, res) => {
  try {
    const recipes = await dbAll("SELECT * FROM recipes");
    for (let recipe of recipes) {
      recipe.ingredients = await dbAll(`
        SELECT ri.*, rm.name, rm.unit 
        FROM recipe_ingredients ri
        JOIN raw_materials rm ON ri.raw_material_id = rm.id
        WHERE ri.recipe_id = ?
      `, [recipe.id]);
    }
    res.json(recipes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🏭 PRODUCTION & RECIPE DEDUCTION (FEFO)
// ==========================================

// POST Start Production Batch
app.post('/api/v1/production/start', async (req, res) => {
  const { recipe_id, batch_code, user_role, user_name } = req.body;
  if (!recipe_id || !batch_code) {
    return res.status(400).json({ error: "recipe_id and batch_code are required" });
  }

  try {
    // 1. Get Recipe details
    const recipe = await dbGet("SELECT * FROM recipes WHERE id = ?", [recipe_id]);
    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    const ingredients = await dbAll(`
      SELECT ri.*, rm.name, rm.current_stock, rm.unit 
      FROM recipe_ingredients ri
      JOIN raw_materials rm ON ri.raw_material_id = rm.id
      WHERE ri.recipe_id = ?
    `, [recipe_id]);

    // 2. Perform FEFO validation: Verify enough non-expired stocks exist
    const allocations = []; // Will hold { raw_material_id, inventory_batch_id, qtyToDeduct, batchName }
    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

    for (let ing of ingredients) {
      // Find active batches ordered by expiry date (FEFO)
      const batches = await dbAll(`
        SELECT * FROM inventory_batches 
        WHERE raw_material_id = ? AND remaining_quantity > 0 AND expiry_date >= ?
        ORDER BY expiry_date ASC
      `, [ing.raw_material_id, nowStr]);

      let requiredQty = ing.quantity_required;
      let availableQty = 0;
      const materialAllocations = [];

      for (let batch of batches) {
        if (requiredQty <= 0) break;
        const take = Math.min(batch.remaining_quantity, requiredQty);
        requiredQty -= take;
        availableQty += take;
        materialAllocations.push({
          raw_material_id: ing.raw_material_id,
          inventory_batch_id: batch.id,
          quantity_used: take,
          batch_number: batch.batch_number
        });
      }

      if (requiredQty > 0) {
        return res.status(400).json({
          error: `Insufficient stock under FEFO rules for ingredient '${ing.name}'. Required: ${ing.quantity_required} ${ing.unit}, Available: ${availableQty} ${ing.unit}`
        });
      }

      allocations.push(...materialAllocations);
    }

    // 3. Deduct stock and commit changes (Wrap in SQL transactions or serial execution)
    const newBatchResult = await dbRun(
      "INSERT INTO production_batches (batch_code, recipe_id, flavor_name, status, quantity_produced) VALUES (?, ?, ?, ?, ?)",
      [batch_code, recipe_id, recipe.name, 'MIXING', 0]
    );
    const productionBatchId = newBatchResult.lastID;

    for (let alloc of allocations) {
      // Deduct from inventory batch
      const batchObj = await dbGet("SELECT * FROM inventory_batches WHERE id = ?", [alloc.inventory_batch_id]);
      const newRemaining = batchObj.remaining_quantity - alloc.quantity_used;
      await dbRun("UPDATE inventory_batches SET remaining_quantity = ? WHERE id = ?", [newRemaining, alloc.inventory_batch_id]);

      // Deduct from raw materials current_stock
      const rawMatObj = await dbGet("SELECT * FROM raw_materials WHERE id = ?", [alloc.raw_material_id]);
      const newRawStock = rawMatObj.current_stock - alloc.quantity_used;
      await dbRun("UPDATE raw_materials SET current_stock = ? WHERE id = ?", [newRawStock, alloc.raw_material_id]);

      // Log link in batch_ingredients
      await dbRun(
        "INSERT INTO batch_ingredients (production_batch_id, raw_material_id, inventory_batch_id, quantity_used) VALUES (?, ?, ?, ?)",
        [productionBatchId, alloc.raw_material_id, alloc.inventory_batch_id, alloc.quantity_used]
      );
    }

    // 4. Log Audit Trail
    await logAudit(
      user_role || "PRODUCTION_SUPERVISOR",
      user_name || "Supervisor",
      "BATCH_CREATED",
      "production_batches",
      productionBatchId,
      null,
      { batch_code, recipe: recipe.name, status: 'MIXING', ingredients_allocated: allocations.length }
    );

    // 5. Broadcast WS Update
    broadcast("PRODUCTION_STARTED", { batch_code, flavor_name: recipe.name });
    res.json({ success: true, productionBatchId, batch_code, flavor_name: recipe.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Production Batches
app.get('/api/v1/production/batches', async (req, res) => {
  try {
    const batches = await dbAll("SELECT * FROM production_batches ORDER BY id DESC");
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Add Finished Product Batch (Manual)
app.post('/api/v1/production/batches', async (req, res) => {
  const { batch_code, flavor_name, status, quantity_produced, expiry_date, user_role, user_name } = req.body;
  if (!batch_code || !flavor_name || !status) {
    return res.status(400).json({ error: "batch_code, flavor_name, and status are required" });
  }
  try {
    let expiryStr = expiry_date || null;
    if (status === 'COMPLETED' && !expiryStr) {
      const exp = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      expiryStr = exp.toISOString().replace('T', ' ').substring(0, 19);
    }
    
    let recipeId = null;
    const recipe = await dbGet("SELECT * FROM recipes WHERE name = ?", [flavor_name]);
    if (recipe) {
      recipeId = recipe.id;
    }

    const result = await dbRun(
      "INSERT INTO production_batches (batch_code, recipe_id, flavor_name, status, quantity_produced, expiry_date) VALUES (?, ?, ?, ?, ?, ?)",
      [batch_code, recipeId, flavor_name, status, parseFloat(quantity_produced || 0), expiryStr]
    );

    if (status === 'COMPLETED') {
      const fg = await dbGet("SELECT * FROM finished_goods WHERE name = ?", [flavor_name]);
      if (fg) {
        await dbRun("UPDATE finished_goods SET stock_qty = ? WHERE id = ?", [fg.stock_qty + parseFloat(quantity_produced || 0), fg.id]);
      }
    }

    await logAudit(
      user_role || "PRODUCTION_SUPERVISOR",
      user_name || "Supervisor",
      "BATCH_CREATED_MANUAL",
      "production_batches",
      result.lastID,
      null,
      { batch_code, flavor_name, status, quantity_produced, expiry_date: expiryStr }
    );

    broadcast("PRODUCTION_STARTED", { batch_code, flavor_name, status });
    res.json({ success: true, id: result.lastID, batch_code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE Finished Product Batch
app.delete('/api/v1/production/batches/:id', async (req, res) => {
  const { id } = req.params;
  const { user_role, user_name } = req.body;
  try {
    const batch = await dbGet("SELECT * FROM production_batches WHERE id = ?", [id]);
    if (!batch) {
      return res.status(404).json({ error: "Batch not found" });
    }

    if (batch.status === 'COMPLETED' && batch.quantity_produced > 0) {
      const fg = await dbGet("SELECT * FROM finished_goods WHERE name = ?", [batch.flavor_name]);
      if (fg) {
        const newStock = Math.max(0, fg.stock_qty - batch.quantity_produced);
        await dbRun("UPDATE finished_goods SET stock_qty = ? WHERE id = ?", [newStock, fg.id]);
      }
    }

    await dbRun("DELETE FROM production_batches WHERE id = ?", [id]);

    await logAudit(
      user_role || "PRODUCTION_SUPERVISOR",
      user_name || "Supervisor",
      "BATCH_DELETED",
      "production_batches",
      id,
      { batch_code: batch.batch_code, status: batch.status, quantity_produced: batch.quantity_produced },
      null
    );

    broadcast("PRODUCTION_STARTED", { deleted_batch: batch.batch_code });
    res.json({ success: true, message: `Deleted production batch ${batch.batch_code} successfully.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT Update Production Batch Status
app.put('/api/v1/production/batches/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, user_role, user_name } = req.body;
  if (!status) return res.status(400).json({ error: "status is required" });

  try {
    const batch = await dbGet("SELECT * FROM production_batches WHERE id = ?", [id]);
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    let expiryDate = batch.expiry_date;
    let yieldQuantity = batch.quantity_produced;
    let updateFields = "status = ?";
    let params = [status];

    // If changing to AGING, calculate aging end timer
    if (status === 'AGING') {
      const now = new Date();
      const agingEndTime = new Date(now.getTime() + 6 * 60 * 60 * 1000); // 6 hours mix aging duration
      const agingEndStr = agingEndTime.toISOString().replace('T', ' ').substring(0, 19);
      updateFields += ", aging_end_time = ?";
      params.push(agingEndStr);
    }

    // If completed, add output to finished goods stock and define expiry
    if (status === 'COMPLETED' && batch.status !== 'COMPLETED') {
      const recipe = await dbGet("SELECT * FROM recipes WHERE id = ?", [batch.recipe_id]);
      if (recipe) {
        yieldQuantity = recipe.yield_quantity;
        // Increase finished goods stock
        const fg = await dbGet("SELECT * FROM finished_goods WHERE name = ?", [recipe.name]);
        if (fg) {
          await dbRun("UPDATE finished_goods SET stock_qty = ? WHERE id = ?", [fg.stock_qty + yieldQuantity, fg.id]);
        }
        
        // Calculate expiry: 90 days from now
        const now = new Date();
        const exp = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
        expiryDate = exp.toISOString().replace('T', ' ').substring(0, 19);
        updateFields += ", expiry_date = ?, quantity_produced = ?";
        params.push(expiryDate, yieldQuantity);
      }
    }

    params.push(id);
    await dbRun(`UPDATE production_batches SET ${updateFields} WHERE id = ?`, params);

    // Log Audit
    await logAudit(
      user_role || "PRODUCTION_SUPERVISOR",
      user_name || "Supervisor",
      "BATCH_STATUS_UPDATE",
      "production_batches",
      id,
      { status: batch.status },
      { status, quantity_produced: yieldQuantity, expiry_date: expiryDate }
    );

    // WS Event
    broadcast("PRODUCTION_UPDATED", { id, status, flavor_name: batch.flavor_name });
    res.json({ success: true, status, quantity_produced: yieldQuantity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 💰 SALES & BILLING API
// ==========================================

// GET Finished Goods Stock
app.get('/api/v1/finished-goods', async (req, res) => {
  try {
    const stock = await dbAll("SELECT * FROM finished_goods");
    res.json(stock);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Add New Product (Finished Good)
app.post('/api/v1/finished-goods', async (req, res) => {
  const { name, SKU, price, stock_qty, unit, user_role, user_name } = req.body;
  if (!name || !SKU || price === undefined || stock_qty === undefined) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  
  try {
    const existing = await dbGet("SELECT * FROM finished_goods WHERE SKU = ? OR name = ?", [SKU, name]);
    if (existing) {
      return res.status(400).json({ error: "Product with this SKU or Name already exists" });
    }

    const result = await dbRun(
      "INSERT INTO finished_goods (name, SKU, price, stock_qty, unit) VALUES (?, ?, ?, ?, ?)",
      [name, SKU, parseFloat(price), parseInt(stock_qty), unit || 'pcs']
    );
    const productId = result.lastID;

    // Log Audit
    await logAudit(
      user_role || "ADMIN",
      user_name || "Manager",
      "PRODUCT_CREATED",
      "finished_goods",
      productId,
      null,
      { name, SKU, price, stock_qty, unit: unit || 'pcs' }
    );

    broadcast("INVENTORY_UPDATED", { type: "PRODUCT_CREATED", SKU });
    res.json({ success: true, productId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE Product
app.delete('/api/v1/finished-goods/:id', async (req, res) => {
  const { id } = req.params;
  const { user_role, user_name } = req.body;

  try {
    const prod = await dbGet("SELECT * FROM finished_goods WHERE id = ?", [id]);
    if (!prod) {
      return res.status(404).json({ error: "Product not found" });
    }

    await dbRun("DELETE FROM finished_goods WHERE id = ?", [id]);

    // Log Audit
    await logAudit(
      user_role || "ADMIN",
      user_name || "Manager",
      "PRODUCT_DELETED",
      "finished_goods",
      id,
      { name: prod.name, SKU: prod.SKU, price: prod.price, stock_qty: prod.stock_qty },
      null
    );

    broadcast("INVENTORY_UPDATED", { type: "PRODUCT_DELETED", SKU: prod.SKU });
    res.json({ success: true, message: `Discontinued finished good ${prod.name} successfully.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT Update Product Base Price
app.put('/api/v1/finished-goods/:id/price', async (req, res) => {
  const { id } = req.params;
  const { price, user_role, user_name } = req.body;
  if (price === undefined) {
    return res.status(400).json({ error: "Missing price field" });
  }

  try {
    const prod = await dbGet("SELECT * FROM finished_goods WHERE id = ?", [id]);
    if (!prod) {
      return res.status(404).json({ error: "Product not found" });
    }

    await dbRun("UPDATE finished_goods SET price = ? WHERE id = ?", [parseFloat(price), id]);

    // Log Audit
    await logAudit(
      user_role || "ADMIN",
      user_name || "Manager",
      "PRODUCT_PRICE_UPDATED",
      "finished_goods",
      id,
      { price: prod.price },
      { price: parseFloat(price) }
    );

    broadcast("INVENTORY_UPDATED", { type: "PRODUCT_PRICE_UPDATED", SKU: prod.SKU, price: parseFloat(price) });
    res.json({ success: true, newPrice: parseFloat(price) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Orders
app.get('/api/v1/sales/orders', async (req, res) => {
  try {
    const orders = await dbAll("SELECT * FROM orders ORDER BY id DESC");
    for (let order of orders) {
      order.items = await dbAll("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
    }
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Distributors
app.get('/api/v1/distributors', async (req, res) => {
  try {
    const distributors = await dbAll("SELECT * FROM distributors ORDER BY name ASC");
    res.json(distributors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Add New Distributor
app.post('/api/v1/distributors', async (req, res) => {
  const { name, location, user_role, user_name } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Distributor name is required" });
  }

  try {
    const existing = await dbGet("SELECT * FROM distributors WHERE name = ?", [name]);
    if (existing) {
      return res.status(400).json({ error: "Distributor already exists" });
    }

    const result = await dbRun(
      "INSERT INTO distributors (name, location) VALUES (?, ?)",
      [name, location || '']
    );
    const distributorId = result.lastID;

    // Log Audit
    await logAudit(
      user_role || "ADMIN",
      user_name || "Manager",
      "DISTRIBUTOR_CREATED",
      "distributors",
      distributorId,
      null,
      { name, location: location || '' }
    );

    broadcast("DISTRIBUTORS_UPDATED", { type: "DISTRIBUTOR_CREATED", name });
    res.json({ success: true, distributorId, name, location });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// PUT Update Order Status (Pending -> Dispatched -> Completed)
app.put('/api/v1/sales/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, user_role, user_name } = req.body;
  if (!status) return res.status(400).json({ error: "status is required" });

  if (!['PENDING', 'DISPATCHED', 'COMPLETED'].includes(status)) {
    return res.status(400).json({ error: "Invalid status value. Must be PENDING, DISPATCHED, or COMPLETED." });
  }

  try {
    const order = await dbGet("SELECT * FROM orders WHERE id = ?", [id]);
    if (!order) return res.status(404).json({ error: "Order not found" });

    await dbRun("UPDATE orders SET status = ? WHERE id = ?", [status, id]);

    // Log Audit
    await logAudit(
      user_role || "SALES_AGENT",
      user_name || "Sales Desk",
      "ORDER_STATUS_UPDATE",
      "orders",
      id,
      { status: order.status },
      { status }
    );

    broadcast("ORDER_UPDATED", { id, status, orderCode: order.order_code });
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Create Order
app.post('/api/v1/sales/orders', async (req, res) => {
  const { customer_name, location, items, user_role, user_name } = req.body;
  if (!customer_name || !items || items.length === 0) {
    return res.status(400).json({ error: "customer_name and items are required" });
  }

  try {
    // 1. Verify finished stock
    let totalAmt = 0;
    const validatedItems = [];

    for (let item of items) {
      const fg = await dbGet("SELECT * FROM finished_goods WHERE name = ?", [item.name]);
      if (!fg) {
        return res.status(404).json({ error: `Product '${item.name}' not found` });
      }
      if (fg.stock_qty < item.quantity) {
        return res.status(400).json({ error: `Insufficient stock for '${item.name}'. Available: ${fg.stock_qty}, Requested: ${item.quantity}` });
      }
      const itemPrice = item.price !== undefined ? parseFloat(item.price) : fg.price;
      const itemCost = itemPrice * item.quantity;
      totalAmt += itemCost;
      validatedItems.push({
        fg_id: fg.id,
        name: fg.name,
        quantity: item.quantity,
        price: itemPrice,
        current_stock: fg.stock_qty
      });
    }

    // Calculate tax using dynamic GST setting
    const gstRateSetting = await dbGet("SELECT value FROM settings WHERE key = 'gst_rate'");
    const gstRate = gstRateSetting ? parseFloat(gstRateSetting.value) : 0.18;
    const taxAmt = totalAmt * gstRate;
    const finalAmt = totalAmt + taxAmt;
    const orderCode = `ORD-${Date.now().toString().slice(-6)}`;

    // 2. Insert Order
    const orderResult = await dbRun(
      "INSERT INTO orders (order_code, customer_name, total_amount, tax_amount, status, gst_rate, customer_location) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [orderCode, customer_name, finalAmt, taxAmt, 'PENDING', gstRate, location || '']
    );
    const orderId = orderResult.lastID;

    // 3. Deduct stock and insert items
    for (let vi of validatedItems) {
      await dbRun("INSERT INTO order_items (order_id, product_name, quantity, price) VALUES (?, ?, ?, ?)",
        [orderId, vi.name, vi.quantity, vi.price]);
      await dbRun("UPDATE finished_goods SET stock_qty = ? WHERE id = ?", [vi.current_stock - vi.quantity, vi.fg_id]);
    }

    // 3.5 Auto-store distributor detail
    const existingDist = await dbGet("SELECT * FROM distributors WHERE name = ?", [customer_name]);
    if (!existingDist) {
      await dbRun("INSERT INTO distributors (name, location) VALUES (?, ?)", [customer_name, location || '']);
    } else if (location && location !== existingDist.location) {
      await dbRun("UPDATE distributors SET location = ? WHERE name = ?", [location, customer_name]);
    }

    // 4. Log Audit
    await logAudit(
      user_role || "SALES_AGENT",
      user_name || "Sales Desk",
      "BILL_GENERATED",
      "orders",
      orderId,
      null,
      { orderCode, customer_name, finalAmt }
    );

    broadcast("ORDER_CREATED", { orderCode, customer_name, amount: finalAmt });
    res.json({ success: true, orderId, orderCode, total_amount: finalAmt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Bill Invoice HTML
app.get('/api/v1/sales/orders/:id/invoice', async (req, res) => {
  const { id } = req.params;
  try {
    const order = await dbGet("SELECT * FROM orders WHERE id = ?", [id]);
    if (!order) return res.status(404).send("<h1>Order not found</h1>");

    const items = await dbAll("SELECT * FROM order_items WHERE order_id = ?", [id]);

    // Send styled HTML for the invoice so the user can easily view or print it
    const subtotal = order.total_amount - order.tax_amount;
    const gstPercent = (order.gst_rate !== undefined && order.gst_rate !== null) ? (order.gst_rate * 100).toFixed(1).replace('.0', '') : '18';
    
    let rowsHtml = '';
    items.forEach((item, index) => {
      rowsHtml += `
        <tr>
          <td>${index + 1}</td>
          <td>${item.product_name}</td>
          <td>₹${item.price.toFixed(2)}</td>
          <td>${item.quantity}</td>
          <td>₹${(item.price * item.quantity).toFixed(2)}</td>
        </tr>
      `;
    });

    const invoiceHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Stitch ERP Invoice - ${order.order_code}</title>
        <style>
          body { font-family: 'Inter', sans-serif; color: #333; margin: 20px; }
          .invoice-box { max-width: 800px; margin: auto; padding: 30px; border: 1px solid #eee; box-shadow: 0 0 10px rgba(0, 0, 0, 0.15); font-size: 14px; line-height: 24px; }
          .invoice-header { display: flex; justify-content: space-between; border-bottom: 2px solid #38bdf8; padding-bottom: 20px; margin-bottom: 20px; }
          .invoice-title { font-size: 28px; font-weight: bold; color: #1e3a8a; }
          .company-info { text-align: right; font-size: 12px; color: #666; }
          .details { display: flex; justify-content: space-between; margin-bottom: 30px; }
          table { width: 100%; border-collapse: collapse; text-align: left; }
          th { background: #f8fafc; border-bottom: 2px solid #e2e8f0; padding: 10px; font-weight: 600; }
          td { border-bottom: 1px solid #e2e8f0; padding: 10px; }
          .totals { margin-top: 30px; float: right; width: 300px; }
          .totals-row { display: flex; justify-content: space-between; padding: 6px 0; }
          .grand-total { font-weight: bold; font-size: 18px; border-top: 2px solid #1e3a8a; padding-top: 10px; color: #1e3a8a; }
          .footer { margin-top: 100px; text-align: center; font-size: 11px; color: #999; border-top: 1px dashed #ccc; padding-top: 10px; }
          @media print {
            body { margin: 0; }
            .invoice-box { box-shadow: none; border: none; }
          }
        </style>
      </head>
      <body>
        <div class="invoice-box">
          <div class="invoice-header">
            <div>
              <div class="invoice-title">STITCH ERP</div>
              <div>Ice Cream Manufacturing Solutions</div>
            </div>
            <div class="company-info">
              <strong>Stitch Ice Cream Factory Ltd.</strong><br>
              Cold Chain Zone 4, Warehouse Ave<br>
              GSTIN: 29AAAAA1111A1Z1
            </div>
          </div>
          
          <div class="details">
            <div>
              <strong>Billed To:</strong><br>
              ${order.customer_name}<br>
              Distributor Account
            </div>
            <div style="text-align: right;">
              <strong>Invoice Number:</strong> ${order.order_code}<br>
              <strong>Date:</strong> ${order.order_date}<br>
              <strong>Status:</strong> ${order.status}
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Product Description</th>
                <th>Unit Price</th>
                <th>Qty</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>

          <div class="totals">
            <div class="totals-row">
              <span>Subtotal:</span>
              <span>₹${subtotal.toFixed(2)}</span>
            </div>
            <div class="totals-row">
              <span>GST / Tax (${gstPercent}%):</span>
              <span>₹${order.tax_amount.toFixed(2)}</span>
            </div>
            <div class="totals-row grand-total">
              <span>Total Amount:</span>
              <span>₹${order.total_amount.toFixed(2)}</span>
            </div>
          </div>

          <div style="clear: both;"></div>

          <div class="footer">
            Thank you for your business. This is an electronically generated document. No signature required.
          </div>
        </div>
      </body>
      </html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(invoiceHtml);
  } catch (err) {
    res.status(500).send(`<h1>Error generating invoice</h1><p>${err.message}</p>`);
  }
});

// ==========================================
// 🚛 GATE & LOGISTICS API
// ==========================================

// GET Gate Logs
app.get('/api/v1/logistics/gate-logs', async (req, res) => {
  try {
    const logs = await dbAll("SELECT * FROM gate_logs ORDER BY id DESC");
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Gate In
app.post('/api/v1/logistics/gate-in', async (req, res) => {
  const { vehicle_number, driver_name, purpose, user_role, user_name } = req.body;
  if (!vehicle_number || !driver_name || !purpose) {
    return res.status(400).json({ error: "vehicle_number, driver_name, and purpose are required" });
  }

  try {
    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const result = await dbRun(
      "INSERT INTO gate_logs (vehicle_number, driver_name, purpose, time_in) VALUES (?, ?, ?, ?)",
      [vehicle_number, driver_name, purpose, nowStr]
    );
    const logId = result.lastID;

    // Log Audit
    await logAudit(
      user_role || "LOGISTICS_AGENT",
      user_name || "Gate Clerk",
      "VEHICLE_GATE_IN",
      "gate_logs",
      logId,
      null,
      { vehicle_number, driver_name, time_in: nowStr }
    );

    broadcast("GATE_IN_EVENT", { id: logId, vehicle_number, time_in: nowStr });
    res.json({ success: true, id: logId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT Gate Out
app.put('/api/v1/logistics/gate-out/:id', async (req, res) => {
  const { id } = req.params;
  const { user_role, user_name } = req.body;

  try {
    const log = await dbGet("SELECT * FROM gate_logs WHERE id = ?", [id]);
    if (!log) return res.status(404).json({ error: "Gate log entry not found" });

    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await dbRun("UPDATE gate_logs SET time_out = ? WHERE id = ?", [nowStr, id]);

    // Log Audit
    await logAudit(
      user_role || "LOGISTICS_AGENT",
      user_name || "Gate Clerk",
      "VEHICLE_GATE_OUT",
      "gate_logs",
      id,
      { time_in: log.time_in },
      { time_in: log.time_in, time_out: nowStr }
    );

    broadcast("GATE_OUT_EVENT", { id, vehicle_number: log.vehicle_number, time_out: nowStr });
    res.json({ success: true, time_out: nowStr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🔍 TRACEABILITY & AUDIT API
// ==========================================

// GET Batch Traceability Matrix
app.get('/api/v1/traceability/:batch_code', async (req, res) => {
  const { batch_code } = req.params;
  try {
    const batch = await dbGet("SELECT * FROM production_batches WHERE batch_code = ?", [batch_code]);
    if (!batch) return res.status(404).json({ error: "Production batch not found" });

    // Find ingredients and supplier batches
    const ingredients = await dbAll(`
      SELECT bi.quantity_used, ib.batch_number as supplier_batch, ib.expiry_date, rm.name as raw_material_name, rm.SKU
      FROM batch_ingredients bi
      JOIN inventory_batches ib ON bi.inventory_batch_id = ib.id
      JOIN raw_materials rm ON bi.raw_material_id = rm.id
      WHERE bi.production_batch_id = ?
    `, [batch.id]);

    res.json({
      batch_code: batch.batch_code,
      flavor_name: batch.flavor_name,
      status: batch.status,
      start_time: batch.start_time,
      expiry_date: batch.expiry_date,
      ingredients
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Audit Logs
app.get('/api/v1/audit-trails', async (req, res) => {
  try {
    const logs = await dbAll("SELECT * FROM audit_trails ORDER BY id DESC LIMIT 100");
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 📊 DASHBOARD & REPORTING API
// ==========================================

// GET Full Year Financial Dashboard metrics
app.get('/api/v1/dashboard/financials/full-year', async (req, res) => {
  try {
    const orders = await dbAll("SELECT total_amount, tax_amount, order_date FROM orders WHERE status = 'COMPLETED'");
    
    // Calculate totals
    let totalRevenue = 0;
    let totalTax = 0;
    let totalOrders = orders.length;

    orders.forEach(order => {
      totalRevenue += order.total_amount;
      totalTax += order.tax_amount;
    });

    const totalProfit = totalRevenue * 0.35; // 35% margin assumption

    // Generate monthly series (last 12 months)
    const now = new Date();
    const monthlySeries = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthKey = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
      const monthLabel = d.toLocaleString('default', { month: 'short', year: 'numeric' });
      monthlySeries.push({ key: monthKey, label: monthLabel, revenue: 0, tax: 0, orderCount: 0 });
    }

    orders.forEach(order => {
      if (order.order_date) {
        const key = order.order_date.substring(0, 7); // YYYY-MM
        const monthItem = monthlySeries.find(m => m.key === key);
        if (monthItem) {
          monthItem.revenue += order.total_amount;
          monthItem.tax += order.tax_amount;
          monthItem.orderCount++;
        }
      }
    });

    // Top selling products query
    const topSellers = await dbAll(`
      SELECT product_name, SUM(quantity) as quantity_sold, SUM(quantity * price) as revenue
      FROM order_items
      JOIN orders ON order_items.order_id = orders.id
      GROUP BY product_name
      ORDER BY quantity_sold DESC
      LIMIT 5
    `);

    // Compile distributor matrix
    const distributorMatrix = await dbAll(`
      SELECT o.customer_name as name, d.location, COUNT(DISTINCT o.id) as orderCount, SUM(o.tax_amount) as totalTax, SUM(o.total_amount) as totalSales, SUM(oi.quantity) as totalQty
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN distributors d ON o.customer_name = d.name
      GROUP BY o.customer_name
      ORDER BY totalSales DESC
    `);

    res.json({
      summary: {
        totalRevenue,
        totalTax,
        totalProfit,
        totalOrders
      },
      monthlySeries,
      topSellers,
      distributorMatrix
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Monthly Dashboard metrics
app.get('/api/v1/dashboard/operations/monthly', async (req, res) => {
  const selectedMonth = req.query.month || new Date().toISOString().substring(0, 7); // YYYY-MM
  try {
    const monthPattern = `${selectedMonth}%`;

    // 1. Total sales and tax in this month
    const salesSummary = await dbGet(`
      SELECT SUM(total_amount) as total_sales, SUM(tax_amount) as total_tax, COUNT(*) as order_count 
      FROM orders 
      WHERE order_date LIKE ?
    `, [monthPattern]);

    // 2. Batches completed in this month
    const batchSummary = await dbGet(`
      SELECT COUNT(*) as completed_count, SUM(quantity_produced) as total_produced 
      FROM production_batches 
      WHERE status = 'COMPLETED' AND start_time LIKE ?
    `, [monthPattern]);

    // 3. Gate Traffic (truck count checked in) in this month
    const gateSummary = await dbGet(`
      SELECT COUNT(*) as vehicle_count 
      FROM gate_logs 
      WHERE time_in LIKE ?
    `, [monthPattern]);

    // 4. Raw Materials Used in this month
    const rawUsed = await dbAll(`
      SELECT rm.name, SUM(bi.quantity_used) as total_used, rm.unit
      FROM batch_ingredients bi
      JOIN raw_materials rm ON bi.raw_material_id = rm.id
      JOIN production_batches pb ON bi.production_batch_id = pb.id
      WHERE pb.start_time LIKE ?
      GROUP BY rm.name
    `, [monthPattern]);

    // 5. Daily production and sales
    const orders = await dbAll(`
      SELECT order_date, total_amount 
      FROM orders 
      WHERE order_date LIKE ?
    `, [monthPattern]);

    const batches = await dbAll(`
      SELECT start_time, quantity_produced 
      FROM production_batches 
      WHERE status = 'COMPLETED' AND start_time LIKE ?
    `, [monthPattern]);

    // Construct days array
    const parts = selectedMonth.split('-');
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    const numDays = new Date(year, month, 0).getDate();

    const dailyData = [];
    for (let day = 1; day <= numDays; day++) {
      const dayStr = day.toString().padStart(2, '0');
      dailyData.push({
        day: day,
        dateKey: `${selectedMonth}-${dayStr}`,
        sales: 0,
        production: 0
      });
    }

    orders.forEach(o => {
      if (o.order_date && o.order_date.length >= 10) {
        const day = parseInt(o.order_date.substring(8, 10));
        if (day >= 1 && day <= numDays) {
          dailyData[day - 1].sales += o.total_amount;
        }
      }
    });

    batches.forEach(b => {
      if (b.start_time && b.start_time.length >= 10) {
        const day = parseInt(b.start_time.substring(8, 10));
        if (day >= 1 && day <= numDays) {
          dailyData[day - 1].production += b.quantity_produced;
        }
      }
    });

    // 6. Recipe production breakdown
    const recipeBreakdown = await dbAll(`
      SELECT flavor_name, SUM(quantity_produced) as total_qty, COUNT(*) as batch_count
      FROM production_batches
      WHERE status = 'COMPLETED' AND start_time LIKE ?
      GROUP BY flavor_name
    `, [monthPattern]);

    // 7. Monthly Distributor matrix
    const distributorMatrix = await dbAll(`
      SELECT o.customer_name as name, d.location, COUNT(DISTINCT o.id) as orderCount, SUM(o.tax_amount) as totalTax, SUM(o.total_amount) as totalSales, SUM(oi.quantity) as totalQty
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN distributors d ON o.customer_name = d.name
      WHERE o.order_date LIKE ?
      GROUP BY o.customer_name
      ORDER BY totalSales DESC
    `, [monthPattern]);

    res.json({
      month: selectedMonth,
      summary: {
        totalSales: salesSummary.total_sales || 0,
        orderCount: salesSummary.order_count || 0,
        batchesCompleted: batchSummary.completed_count || 0,
        totalProduced: batchSummary.total_produced || 0,
        gateTraffic: gateSummary.vehicle_count || 0,
        rawMaterialsUsed: rawUsed
      },
      dailyData,
      recipeBreakdown,
      distributorMatrix
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🚀 SERVER INIT
// ==========================================

initDb().then(() => {
  server.listen(port, () => {
    console.log(`Stitch ERP Backend listening on http://localhost:${port}`);
  });
}).catch(err => {
  console.error("Failed to initialize database, server not starting:", err);
});
