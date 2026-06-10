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

// Handle favicon
app.get('/favicon.ico', (req, res) => res.status(204).end());

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

    const role = userRoleRecord ? userRoleRecord.role : 'ADMIN';
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

  if (role !== 'ADMIN') {
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
      SELECT b.*, m.name as material_name, m.unit, m.SKU as SKU 
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
  const { name, SKU, unit, quantity, expiry_date, capacity, safety, unit_price, user_role, user_name } = req.body;
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
    await dbRun(`INSERT INTO inventory_batches (raw_material_id, batch_number, quantity_received, remaining_quantity, unit_price, expiry_date) 
           VALUES (?, ?, ?, ?, ?, ?)`, [rawMaterialId, batchNumber, parseFloat(quantity), parseFloat(quantity), parseFloat(unit_price || 0.0), expiryTimestamp]);

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
// GET Recipes
app.get('/api/v1/recipes', async (req, res) => {
  try {
    const recipes = await dbAll("SELECT * FROM recipes");
    if (recipes.length > 0) {
      const recipeIds = recipes.map(r => r.id);
      const allIngredients = await dbAll(`
        SELECT ri.*, rm.name, rm.unit 
        FROM recipe_ingredients ri
        JOIN raw_materials rm ON ri.raw_material_id = rm.id
        WHERE ri.recipe_id = ANY(?)
      `, [recipeIds]);
      
      const ingredientsMap = {};
      allIngredients.forEach(ing => {
        if (!ingredientsMap[ing.recipe_id]) {
          ingredientsMap[ing.recipe_id] = [];
        }
        ingredientsMap[ing.recipe_id].push(ing);
      });
      
      recipes.forEach(recipe => {
        recipe.ingredients = ingredientsMap[recipe.id] || [];
      });
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
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  try {
    const orders = await dbAll("SELECT * FROM orders ORDER BY id DESC LIMIT ? OFFSET ?", [limit, offset]);
    if (orders.length > 0) {
      const orderIds = orders.map(o => o.id);
      const allItems = await dbAll("SELECT * FROM order_items WHERE order_id = ANY(?)", [orderIds]);
      const itemsMap = {};
      allItems.forEach(item => {
        if (!itemsMap[item.order_id]) {
          itemsMap[item.order_id] = [];
        }
        itemsMap[item.order_id].push(item);
      });
      orders.forEach(order => {
        order.items = itemsMap[order.id] || [];
      });
    }
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Distributors
app.get('/api/v1/distributors', async (req, res) => {
  try {
    const distributors = await dbAll(`
      SELECT 
        d.*,
        COALESCE((SELECT SUM(o.total_amount) FROM orders o WHERE o.customer_name = d.name), 0) as balance
      FROM distributors d
      ORDER BY d.name ASC
    `);
    res.json(distributors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Last Prices for a Customer
app.get('/api/v1/sales/last-prices', async (req, res) => {
  const { customer_name } = req.query;
  if (!customer_name) {
    return res.status(400).json({ error: "customer_name parameter is required" });
  }
  try {
    const rows = await dbAll(`
      SELECT DISTINCT ON (product_name) product_name, price
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.customer_name = ?
      ORDER BY product_name, o.id DESC
    `, [customer_name]);
    
    const pricingMap = {};
    rows.forEach(row => {
      pricingMap[row.product_name] = row.price;
    });
    
    res.json(pricingMap);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Add New Distributor
app.post('/api/v1/distributors', async (req, res) => {
  const { name, location, gstin, phone, user_role, user_name } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Distributor name is required" });
  }

  try {
    const existing = await dbGet("SELECT * FROM distributors WHERE name = ?", [name]);
    if (existing) {
      return res.status(400).json({ error: "Distributor already exists" });
    }

    const result = await dbRun(
      "INSERT INTO distributors (name, location, gstin, phone) VALUES (?, ?, ?, ?)",
      [name, location || '', gstin || '', phone || '']
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
      { name, location: location || '', gstin: gstin || '', phone: phone || '' }
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
  const { customer_name, location, items, include_gst, user_role, user_name } = req.body;
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
    let gstRate = 0;
    if (include_gst !== false) {
      const gstRateSetting = await dbGet("SELECT value FROM settings WHERE key = 'gst_rate'");
      gstRate = gstRateSetting ? parseFloat(gstRateSetting.value) : 0.18;
    }
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

app.get('/api/v1/sales/orders/:id/invoice', async (req, res) => {
  const { id } = req.params;
  try {
    const order = await dbGet("SELECT * FROM orders WHERE id = ?", [id]);
    if (!order) return res.status(404).send("<h1>Order not found</h1>");

    const items = await dbAll("SELECT * FROM order_items WHERE order_id = ?", [id]);
    const dist = await dbGet("SELECT * FROM distributors WHERE name = ?", [order.customer_name]);

    const buyerAddress = (order.customer_location && order.customer_location !== 'null') ? order.customer_location : ((dist && dist.location && dist.location !== 'null') ? dist.location : "N/A");
    const buyerGstin = (order.customer_gstin && order.customer_gstin !== 'null') ? order.customer_gstin : ((dist && dist.gstin && dist.gstin !== 'null') ? dist.gstin : "N/A");
    const buyerPhone = (dist && dist.phone && dist.phone !== 'null') ? dist.phone : "N/A";

    const oDate = new Date(order.order_date);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const formattedDate = `${oDate.getDate()}-${months[oDate.getMonth()]}-${oDate.getFullYear().toString().substring(2)}`; // e.g. 1-May-26

    // Helper to format currency in Indian style
    function formatIndianCurrency(num) {
      if (num === undefined || num === null || isNaN(num)) return '0.00';
      return Number(num).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // Helper: State from GSTIN
    function getStateFromGstin(gstin) {
      if (!gstin || gstin === 'N/A' || gstin.trim().length < 2) {
        return { name: 'Haryana', code: '06' };
      }
      const prefix = gstin.trim().substring(0, 2);
      const stateMap = {
        '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
        '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
        '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
        '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
        '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
        '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
        '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '29': 'Karnataka',
        '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
        '34': 'Puducherry', '35': 'Andaman & Nicobar Islands', '36': 'Telangana',
        '37': 'Andhra Pradesh', '38': 'Ladakh'
      };
      return {
        name: stateMap[prefix] || 'Haryana',
        code: prefix
      };
    }

    const buyerState = getStateFromGstin(buyerGstin);

    // Dynamic tax determination
    const gstinClean = (buyerGstin && buyerGstin !== 'N/A') ? buyerGstin.trim() : '';
    const isLocal = gstinClean ? gstinClean.startsWith('06') : true; // default to Haryana (local)

    // Calculate subtotal, taxes, and round off
    const subtotal = order.total_amount - order.tax_amount;
    const cgstVal = isLocal ? order.tax_amount / 2 : 0;
    const sgstVal = isLocal ? order.tax_amount / 2 : 0;
    const igstVal = isLocal ? 0 : order.tax_amount;
    const grandTotalRounded = Math.round(order.total_amount);
    const roundOffVal = grandTotalRounded - order.total_amount;

    const cgstRate = order.gst_rate > 0 ? `${((order.gst_rate / 2) * 100).toFixed(2).replace('.00', '')}%` : '0%';
    const sgstRate = order.gst_rate > 0 ? `${((order.gst_rate / 2) * 100).toFixed(2).replace('.00', '')}%` : '0%';
    const igstRate = order.gst_rate > 0 ? `${(order.gst_rate * 100).toFixed(2).replace('.00', '')}%` : '0%';

    // Helper: Number to Words
    function numberToWords(num) {
      const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
      const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

      function g(n) {
        if (n < 20) return a[n];
        let digit = n % 10;
        return b[Math.floor(n / 10)] + (digit ? ' ' + a[digit] : '');
      }

      function h(n) {
        if (n === 0) return '';
        if (n < 100) return g(n);
        let rem = n % 100;
        return a[Math.floor(n / 100)] + ' Hundred' + (rem ? ' ' + h(rem) : '');
      }

      function convert(n) {
        if (n === 0) return '';
        let word = '';
        
        let crore = Math.floor(n / 10000000);
        n %= 10000000;
        if (crore) word += h(crore) + ' Crore ';
        
        let lakh = Math.floor(n / 100000);
        n %= 100000;
        if (lakh) word += h(lakh) + ' Lakh ';
        
        let thousand = Math.floor(n / 1000);
        n %= 1000;
        if (thousand) word += h(thousand) + ' Thousand ';
        
        if (n) word += h(n);
        
        return word.trim();
      }

      let parts = Number(num).toFixed(2).split('.');
      let rupees = parseInt(parts[0]);
      let paise = parseInt(parts[1]);

      let word = convert(rupees);
      if (paise > 0) {
        word += ' and ' + convert(paise) + ' paise';
      }
      return 'INR ' + word + ' Only';
    }

    const wordsAmount = numberToWords(grandTotalRounded);
    const taxWordsAmount = numberToWords(order.tax_amount);

    const isGst = order.tax_amount > 0 && order.gst_rate > 0;
    if (!isGst) {
      let rowsHtml = '';
      let totalQtySum = 0;
      let lastUnit = 'BOX';

      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        totalQtySum += item.quantity;

        const fg = await dbGet("SELECT unit FROM finished_goods WHERE name = ?", [item.product_name]);
        const unit = (fg && fg.unit ? fg.unit : "BOX").toUpperCase();
        lastUnit = unit;

        rowsHtml += `
          <tr style="vertical-align: top;">
            <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: center;">${index + 1}</td>
            <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: left;">
              <strong>${item.product_name}</strong>
            </td>
            <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: center;"></td>
            <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: right; font-weight: bold; font-family: monospace;">${item.quantity} ${unit}</td>
            <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(item.price)}</td>
            <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(item.price)}</td>
            <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: center;">${unit}</td>
            <td style="padding: 5px 8px; text-align: right; font-weight: bold; font-family: monospace; border-right: none;">${formatIndianCurrency(item.price * item.quantity)}</td>
          </tr>
        `;
      }

      const fillerHeight = Math.max(120 - (items.length * 20), 40);
      const minHeightRow = `
        <tr style="height: ${fillerHeight}px; vertical-align: top;">
          <td style="border-right: 1px solid #000; padding: 6px;"></td>
          <td style="border-right: 1px solid #000; padding: 6px;"></td>
          <td style="border-right: 1px solid #000; padding: 6px;"></td>
          <td style="border-right: 1px solid #000; padding: 6px;"></td>
          <td style="border-right: 1px solid #000; padding: 6px;"></td>
          <td style="border-right: 1px solid #000; padding: 6px;"></td>
          <td style="border-right: 1px solid #000; padding: 6px;"></td>
          <td style="padding: 6px;"></td>
        </tr>
      `;

      const invoiceHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Invoice - ${order.order_code}</title>
          <style>
            body {
              font-family: Arial, Helvetica, sans-serif;
              color: #000;
              margin: 0;
              padding: 20px;
              background: #fff;
            }
            .invoice-container {
              width: 100%;
              max-width: 800px;
              margin: auto;
              border: 1px solid #000;
              box-sizing: border-box;
              background: #fff;
            }
            .text-center { text-align: center; }
            .text-right { text-align: right; }
            .text-left { text-align: left; }
            .bold { font-weight: bold; }
            
            /* Master 4-column Table Info Grid */
            .info-table {
              width: 100%;
              border-collapse: collapse;
            }
            .info-table td {
              border-bottom: 1px solid #000;
              border-right: 1px solid #000;
              padding: 6px 8px;
              vertical-align: top;
              font-size: 11px;
              line-height: 1.4;
            }
            /* Items table styling */
            .items-table {
              width: 100%;
              border-collapse: collapse;
              font-size: 11px;
            }
            .items-table th {
              border-bottom: 1px solid #000;
              border-right: 1px solid #000;
              padding: 6px 8px;
              text-align: center;
              font-weight: bold;
            }
            .items-table td {
              border-right: 1px solid #000;
              padding: 4px 8px;
            }
            .items-table tr.total-row td {
              border-top: 1px solid #000;
              border-bottom: 1px solid #000;
              padding: 6px 8px;
              font-weight: bold;
            }
            /* Summary and Bank styling */
            .summary-title-cell {
              font-size: 9px;
              color: #444;
              display: block;
              margin-bottom: 3px;
            }
            
            /* Floating buttons only for screen */
            .screen-actions {
              max-width: 800px;
              margin: 0 auto 15px auto;
              text-align: right;
            }
            .btn-print {
              padding: 6px 12px;
              background: #007bff;
              color: #fff;
              border: none;
              border-radius: 4px;
              cursor: pointer;
              font-weight: bold;
              font-size: 12px;
            }
            
            @media print {
              body { padding: 0; }
              .screen-actions { display: none; }
              .invoice-container { max-width: 100%; border: 1px solid #000; }
            }
          </style>
        </head>
        <body>
          <div class="screen-actions">
            <button class="btn-print" onclick="window.print()">Print Invoice</button>
          </div>

          <h3 style="text-align: center; margin: 0 0 10px 0; font-size: 16px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">RETAIL BILL / RECEIPT</h3>
          
          <div class="invoice-container">
            <!-- Seller, Buyer, and Meta Grid -->
            <table class="info-table">
              <tr>
                <!-- Row 1, 2, 3 Left: Seller Details -->
                <td rowspan="3" colspan="2" style="width: 50%;">
                  <strong style="font-size: 13px;">CFF</strong><br>
                  PAL WAS MOD BHIWANI<br>
                  State Name : Haryana, Code : 06<br>
                  Contact : 9813291533
                </td>
                <!-- Row 1 Right: Invoice No. & Dated -->
                <td style="width: 25%;">
                  <span class="summary-title-cell">Invoice No.</span>
                  <strong>${order.order_code}</strong>
                </td>
                <td style="width: 25%; border-right: none;">
                  <span class="summary-title-cell">Dated</span>
                  <strong>${formattedDate}</strong>
                </td>
              </tr>
              <tr>
                <!-- Row 2 Right: Delivery Note & Mode of Payment -->
                <td>
                  <span class="summary-title-cell">Delivery Note</span>
                  &nbsp;
                </td>
                <td style="border-right: none;">
                  <span class="summary-title-cell">Mode/Terms of Payment</span>
                  <strong>${order.payment_status || 'Credit'}</strong>
                </td>
              </tr>
              <tr>
                <!-- Row 3 Right: Reference No. & Other References -->
                <td>
                  <span class="summary-title-cell">Reference No. & Date.</span>
                  &nbsp;
                </td>
                <td style="border-right: none;">
                  <span class="summary-title-cell">Other References</span>
                  &nbsp;
                </td>
              </tr>
              <tr>
                <!-- Row 4, 5, 6, 7 Left: Buyer Details -->
                <td rowspan="4" colspan="2" style="width: 50%;">
                  <span class="summary-title-cell">Buyer (Bill to)</span>
                  <strong style="font-size: 12px; text-transform: uppercase;">${order.customer_name}</strong><br>
                  ${buyerAddress !== 'N/A' ? buyerAddress + '<br>' : ''}
                  State Name &nbsp;&nbsp;&nbsp;&nbsp;: <strong>${buyerState.name}, Code : ${buyerState.code}</strong>
                </td>
                <!-- Row 4 Right: Buyer's Order No. & Dated -->
                <td>
                  <span class="summary-title-cell">Buyer's Order No.</span>
                  &nbsp;
                </td>
                <td style="border-right: none;">
                  <span class="summary-title-cell">Dated</span>
                  &nbsp;
                </td>
              </tr>
              <tr>
                <!-- Row 5 Right: Dispatch Doc No. & Delivery Note Date -->
                <td>
                  <span class="summary-title-cell">Dispatch Doc No.</span>
                  &nbsp;
                </td>
                <td style="border-right: none;">
                  <span class="summary-title-cell">Delivery Note Date</span>
                  &nbsp;
                </td>
              </tr>
              <tr>
                <!-- Row 6 Right: Dispatched through & Destination -->
                <td>
                  <span class="summary-title-cell">Dispatched through</span>
                  &nbsp;
                </td>
                <td style="border-right: none;">
                  <span class="summary-title-cell">Destination</span>
                  &nbsp;
                </td>
              </tr>
              <tr>
                <!-- Row 7 Right: Terms of Delivery -->
                <td colspan="2" style="border-right: none;">
                  <span class="summary-title-cell">Terms of Delivery</span>
                  &nbsp;
                </td>
              </tr>
            </table>
            
            <!-- Items Table (8 columns) -->
            <table class="items-table">
              <thead>
                <tr>
                  <th style="width: 35px; border-bottom: 1px solid #000;">Sl<br>No.</th>
                  <th style="border-bottom: 1px solid #000;">Description of Goods</th>
                  <th style="width: 70px; border-bottom: 1px solid #000;">HSN/SAC</th>
                  <th style="width: 80px; text-align: right; border-bottom: 1px solid #000;">Quantity</th>
                  <th style="width: 90px; text-align: right; border-bottom: 1px solid #000;">Rate<br>(Ind. of Tax)</th>
                  <th style="width: 80px; text-align: right; border-bottom: 1px solid #000;">Rate</th>
                  <th style="width: 50px; text-align: center; border-bottom: 1px solid #000;">per</th>
                  <th style="width: 120px; text-align: right; border-bottom: 1px solid #000; border-right: none;">Amount</th>
                </tr>
              </thead>
              <tbody>
                <!-- Dynamic Rows -->
                ${rowsHtml}
                
                <!-- Blank filling row -->
                ${minHeightRow}
                
                <!-- Grand Total Row -->
                <tr class="total-row">
                  <td style="border-right: 1px solid #000;"></td>
                  <td style="text-align: right; padding-right: 15px; border-right: 1px solid #000;">Total</td>
                  <td style="border-right: 1px solid #000;"></td>
                  <td style="border-right: 1px solid #000;"></td>
                  <td style="border-right: 1px solid #000;"></td>
                  <td style="border-right: 1px solid #000;"></td>
                  <td style="border-right: 1px solid #000;"></td>
                  <td style="text-align: right; font-size: 12px; border-right: none;"><strong>₹ ${formatIndianCurrency(grandTotalRounded)}</strong></td>
                </tr>
              </tbody>
            </table>
            
            <!-- Amount in Words -->
            <table class="info-table" style="border-top: none;">
              <tr>
                <td style="border-bottom: 1px solid #000; border-right: none; padding: 6px 8px;">
                  <span class="summary-title-cell">Amount Chargeable (in words)</span>
                  <strong style="font-size: 11px;">${wordsAmount}</strong>
                  <span style="float: right; font-style: italic; font-size: 10px; font-weight: bold; margin-top: 2px;">E. & O.E</span>
                </td>
              </tr>
            </table>
            
            <!-- Declarations & Signatures -->
            <table class="info-table" style="border-bottom: none;">
              <tr>
                <!-- Left Cell: Declaration -->
                <td style="width: 50%; border-bottom: none; border-right: 1px solid #000; padding: 6px 8px; vertical-align: top;">
                  <strong style="text-decoration: underline; font-size: 10px;">Declaration:</strong><br>
                  We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.
                </td>
                <!-- Right Cell: Signatory -->
                <td style="width: 50%; border-bottom: none; border-right: none; height: 90px; vertical-align: top; position: relative; padding: 6px 8px;">
                  <div style="font-size: 9px; font-weight: bold; text-transform: uppercase;">for CFF</div>
                  <div style="position: absolute; bottom: 8px; right: 8px; text-align: right; font-size: 9px; font-weight: bold;">
                    <br><br><br>
                    Authorised Signatory
                  </div>
                </td>
              </tr>
            </table>
          </div>
          
          <!-- Footer Notes -->
          <div style="text-align: center; font-size: 9px; font-weight: normal; margin-top: 8px; color: #444;">This is a Computer Generated Invoice</div>
        </body>
        </html>
      `;
      res.setHeader('Content-Type', 'text/html');
      res.send(invoiceHtml);
      return;
    }

    let rowsHtml = '';
    let totalQtySum = 0;
    let lastUnit = 'BOX';

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      totalQtySum += item.quantity;

      const fg = await dbGet("SELECT unit FROM finished_goods WHERE name = ?", [item.product_name]);
      const unit = (fg && fg.unit ? fg.unit : "BOX").toUpperCase();
      lastUnit = unit;

      rowsHtml += `
        <tr style="vertical-align: top;">
          <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: center;">${index + 1}</td>
          <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: left;">
            <strong>${item.product_name}</strong>
          </td>
          <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: center; font-family: monospace;">2105</td>
          <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: right; font-weight: bold; font-family: monospace;">${item.quantity} ${unit}</td>
          <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(item.price)}</td>
          <td style="border-right: 1px solid #000; padding: 5px 8px; text-align: center;">${unit}</td>
          <td style="padding: 5px 8px; text-align: right; font-weight: bold; font-family: monospace;">${formatIndianCurrency(item.price * item.quantity)}</td>
        </tr>
      `;
    }

    // Dynamic height calculation for the blank filler row so the table occupies a standard space
    const fillerHeight = Math.max(120 - (items.length * 20), 40);
    const minHeightRow = `
      <tr style="height: ${fillerHeight}px; vertical-align: top;">
        <td style="border-right: 1px solid #000; padding: 6px;"></td>
        <td style="border-right: 1px solid #000; padding: 6px;"></td>
        <td style="border-right: 1px solid #000; padding: 6px;"></td>
        <td style="border-right: 1px solid #000; padding: 6px;"></td>
        <td style="border-right: 1px solid #000; padding: 6px;"></td>
        <td style="border-right: 1px solid #000; padding: 6px;"></td>
        <td style="padding: 6px;"></td>
      </tr>
    `;

    // CGST, SGST, IGST, Round-off Rows
    let taxBreakdownRows = '';
    if (order.tax_amount > 0) {
      if (isLocal) {
        taxBreakdownRows += `
          <tr style="vertical-align: top;">
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="border-right: 1px solid #000; padding: 4px 8px; text-align: right; font-weight: bold; font-style: italic;">CGST</td>
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="padding: 4px 8px; text-align: right; font-weight: bold; font-family: monospace;">${formatIndianCurrency(cgstVal)}</td>
          </tr>
          <tr style="vertical-align: top;">
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="border-right: 1px solid #000; padding: 4px 8px; text-align: right; font-weight: bold; font-style: italic;">SGST</td>
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="padding: 4px 8px; text-align: right; font-weight: bold; font-family: monospace;">${formatIndianCurrency(sgstVal)}</td>
          </tr>
        `;
      } else {
        taxBreakdownRows += `
          <tr style="vertical-align: top;">
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="border-right: 1px solid #000; padding: 4px 8px; text-align: right; font-weight: bold; font-style: italic;">IGST</td>
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
            <td style="padding: 4px 8px; text-align: right; font-weight: bold; font-family: monospace;">${formatIndianCurrency(igstVal)}</td>
          </tr>
        `;
      }
    }
    
    // Round-off Row
    if (Math.abs(roundOffVal) > 0.001) {
      const formattedRoundOff = roundOffVal < 0 ? `(-) ${formatIndianCurrency(Math.abs(roundOffVal))}` : `(+) ${formatIndianCurrency(roundOffVal)}`;
      taxBreakdownRows += `
        <tr style="vertical-align: top;">
          <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
          <td style="border-right: 1px solid #000; padding: 4px 8px; text-align: left; font-size: 10px;">Less: <i>R/OFF</i></td>
          <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
          <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
          <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
          <td style="border-right: 1px solid #000; padding: 4px 8px;"></td>
          <td style="padding: 4px 8px; text-align: right; font-weight: bold; font-family: monospace;">${formattedRoundOff}</td>
        </tr>
      `;
    }

    // Dynamic HSN Summary Columns depending on tax type
    let hsnSummaryHeaderHtml = '';
    let hsnSummaryRowHtml = '';
    if (isLocal) {
      hsnSummaryHeaderHtml = `
        <tr>
          <th rowspan="2" style="border: 1px solid #000; padding: 4px; font-weight: bold;">HSN/SAC</th>
          <th rowspan="2" style="border: 1px solid #000; padding: 4px; text-align: right; font-weight: bold;">Taxable<br>Value</th>
          <th colspan="2" style="border: 1px solid #000; padding: 4px; font-weight: bold;">Central Tax</th>
          <th colspan="2" style="border: 1px solid #000; padding: 4px; font-weight: bold;">State Tax</th>
          <th rowspan="2" style="border: 1px solid #000; padding: 4px; text-align: right; font-weight: bold;">Total<br>Tax Amount</th>
        </tr>
        <tr>
          <th style="border: 1px solid #000; padding: 4px; font-weight: bold;">Rate</th>
          <th style="border: 1px solid #000; padding: 4px; text-align: right; font-weight: bold;">Amount</th>
          <th style="border: 1px solid #000; padding: 4px; font-weight: bold;">Rate</th>
          <th style="border: 1px solid #000; padding: 4px; text-align: right; font-weight: bold;">Amount</th>
        </tr>
      `;
      hsnSummaryRowHtml = `
        <tr>
          <td style="border: 1px solid #000; padding: 4px 8px; font-family: monospace;">2105</td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(subtotal)}</td>
          <td style="border: 1px solid #000; padding: 4px 8px; font-family: monospace;">${cgstRate}</td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(cgstVal)}</td>
          <td style="border: 1px solid #000; padding: 4px 8px; font-family: monospace;">${sgstRate}</td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(sgstVal)}</td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(order.tax_amount)}</td>
        </tr>
        <tr style="font-weight: bold;">
          <td style="border: 1px solid #000; padding: 4px 8px;">Total</td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(subtotal)}</td>
          <td style="border: 1px solid #000; padding: 4px 8px;"></td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(cgstVal)}</td>
          <td style="border: 1px solid #000; padding: 4px 8px;"></td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(sgstVal)}</td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(order.tax_amount)}</td>
        </tr>
      `;
    } else {
      hsnSummaryHeaderHtml = `
        <tr>
          <th rowspan="2" style="border: 1px solid #000; padding: 4px; font-weight: bold;">HSN/SAC</th>
          <th rowspan="2" style="border: 1px solid #000; padding: 4px; text-align: right; font-weight: bold;">Taxable<br>Value</th>
          <th colspan="2" style="border: 1px solid #000; padding: 4px; font-weight: bold;">Integrated Tax</th>
          <th rowspan="2" style="border: 1px solid #000; padding: 4px; text-align: right; font-weight: bold;">Total<br>Tax Amount</th>
        </tr>
        <tr>
          <th style="border: 1px solid #000; padding: 4px; font-weight: bold;">Rate</th>
          <th style="border: 1px solid #000; padding: 4px; text-align: right; font-weight: bold;">Amount</th>
        </tr>
      `;
      hsnSummaryRowHtml = `
        <tr>
          <td style="border: 1px solid #000; padding: 4px 8px; font-family: monospace;">2105</td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(subtotal)}</td>
          <td style="border: 1px solid #000; padding: 4px 8px; font-family: monospace;">${igstRate}</td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(igstVal)}</td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(order.tax_amount)}</td>
        </tr>
        <tr style="font-weight: bold;">
          <td style="border: 1px solid #000; padding: 4px 8px;">Total</td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(subtotal)}</td>
          <td style="border: 1px solid #000; padding: 4px 8px;"></td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(igstVal)}</td>
          <td style="border: 1px solid #000; padding: 4px 8px; text-align: right; font-family: monospace;">${formatIndianCurrency(order.tax_amount)}</td>
        </tr>
      `;
    }

    const invoiceHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Tax Invoice - ${order.order_code}</title>
        <style>
          body {
            font-family: Arial, Helvetica, sans-serif;
            color: #000;
            margin: 0;
            padding: 20px;
            background: #fff;
          }
          .invoice-container {
            width: 100%;
            max-width: 800px;
            margin: auto;
            border: 1px solid #000;
            box-sizing: border-box;
            background: #fff;
          }
          .text-center { text-align: center; }
          .text-right { text-align: right; }
          .text-left { text-align: left; }
          .bold { font-weight: bold; }
          
          /* Master 4-column Table Info Grid */
          .info-table {
            width: 100%;
            border-collapse: collapse;
          }
          .info-table td {
            border-bottom: 1px solid #000;
            border-right: 1px solid #000;
            padding: 6px 8px;
            vertical-align: top;
            font-size: 11px;
            line-height: 1.4;
          }
          /* Items table styling */
          .items-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
          }
          .items-table th {
            border-bottom: 1px solid #000;
            border-right: 1px solid #000;
            padding: 6px 8px;
            text-align: center;
            font-weight: bold;
          }
          .items-table td {
            border-right: 1px solid #000;
            padding: 4px 8px;
          }
          .items-table tr.total-row td {
            border-top: 1px solid #000;
            border-bottom: 1px solid #000;
            padding: 6px 8px;
            font-weight: bold;
          }
          /* Summary and Bank styling */
          .summary-title-cell {
            font-size: 9px;
            color: #444;
            display: block;
            margin-bottom: 3px;
          }
          .hsn-summary-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 10px;
            text-align: center;
          }
          .hsn-summary-table th, .hsn-summary-table td {
            padding: 4px 6px;
          }
          
          /* Floating buttons only for screen */
          .screen-actions {
            max-width: 800px;
            margin: 0 auto 15px auto;
            text-align: right;
          }
          .btn-print {
            padding: 6px 12px;
            background: #007bff;
            color: #fff;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            font-size: 12px;
          }
          
          @media print {
            body { padding: 0; }
            .screen-actions { display: none; }
            .invoice-container { max-width: 100%; border: 1px solid #000; }
          }
        </style>
      </head>
      <body>
        <div class="screen-actions">
          <button class="btn-print" onclick="window.print()">Print Invoice</button>
        </div>

        <h3 style="text-align: center; margin: 0 0 10px 0; font-size: 16px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">TAX INVOICE</h3>
        
        <div class="invoice-container">
          <!-- Seller, Buyer, and Meta Grid -->
          <table class="info-table">
            <tr>
              <!-- Row 1, 2, 3 Left: Seller Details -->
              <td rowspan="3" colspan="2" style="width: 50%;">
                <strong style="font-size: 13px;">CHOKHANI FROZEN FOODS PVT. LTD. - (from 1-Apr</strong><br>
                PALWAS MOD, MEHAM ROAD,<br>
                NEAR CARRIER PLANET PUBLIC SCHOOL,<br>
                BHIWANI-127021<br>
                FSSAI NO. : 10821002000089<br>
                GSTIN/UIN: 06AAGCC3649G1ZP<br>
                State Name : Haryana, Code : 06<br>
                CIN: U15122DL2010PTC208895<br>
                Contact : 9813210061
              </td>
              <!-- Row 1 Right: Invoice No. & Dated -->
              <td style="width: 25%;">
                <span class="summary-title-cell">Invoice No.</span>
                <strong>${order.order_code}</strong>
              </td>
              <td style="width: 25%; border-right: none;">
                <span class="summary-title-cell">Dated</span>
                <strong>${formattedDate}</strong>
              </td>
            </tr>
            <tr>
              <!-- Row 2 Right: Delivery Note & Mode of Payment -->
              <td>
                <span class="summary-title-cell">Delivery Note</span>
                &nbsp;
              </td>
              <td style="border-right: none;">
                <span class="summary-title-cell">Mode/Terms of Payment</span>
                <strong>${order.payment_status || 'Credit'}</strong>
              </td>
            </tr>
            <tr>
              <!-- Row 3 Right: Reference No. & Other References -->
              <td>
                <span class="summary-title-cell">Reference No. & Date</span>
                &nbsp;
              </td>
              <td style="border-right: none;">
                <span class="summary-title-cell">Other References</span>
                &nbsp;
              </td>
            </tr>
            <tr>
              <!-- Row 4, 5, 6, 7 Left: Buyer Details -->
              <td rowspan="4" colspan="2" style="width: 50%;">
                <span class="summary-title-cell">Buyer (Bill to)</span>
                <strong style="font-size: 12px; text-transform: uppercase;">${order.customer_name}</strong><br>
                ${buyerAddress}<br><br>
                GSTIN/UIN &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: <strong>${buyerGstin}</strong><!-- GSTIN: ${buyerGstin} --><br>
                State Name &nbsp;&nbsp;&nbsp;&nbsp;: <strong>${buyerState.name}, Code : ${buyerState.code}</strong>
              </td>
              <!-- Row 4 Right: Buyer's Order No. & Dated -->
              <td>
                <span class="summary-title-cell">Buyer's Order No.</span>
                &nbsp;
              </td>
              <td style="border-right: none;">
                <span class="summary-title-cell">Dated</span>
                &nbsp;
              </td>
            </tr>
            <tr>
              <!-- Row 5 Right: Dispatch Doc No. & Delivery Note Date -->
              <td>
                <span class="summary-title-cell">Dispatch Doc No.</span>
                &nbsp;
              </td>
              <td style="border-right: none;">
                <span class="summary-title-cell">Delivery Note Date</span>
                &nbsp;
              </td>
            </tr>
            <tr>
              <!-- Row 6 Right: Dispatched through & Destination -->
              <td>
                <span class="summary-title-cell">Dispatched through</span>
                &nbsp;
              </td>
              <td style="border-right: none;">
                <span class="summary-title-cell">Destination</span>
                &nbsp;
              </td>
            </tr>
            <tr>
              <!-- Row 7 Right: Terms of Delivery -->
              <td colspan="2" style="border-right: none;">
                <span class="summary-title-cell">Terms of Delivery</span>
                &nbsp;
              </td>
            </tr>
          </table>
          
          <!-- Items Table -->
          <table class="items-table">
            <thead>
              <tr>
                <th style="width: 35px; border-bottom: 1px solid #000;">Sl<br>No.</th>
                <th style="border-bottom: 1px solid #000;">Description of Goods</th>
                <th style="width: 80px; border-bottom: 1px solid #000;">HSN/SAC</th>
                <th style="width: 90px; text-align: right; border-bottom: 1px solid #000;">Quantity</th>
                <th style="width: 80px; text-align: right; border-bottom: 1px solid #000;">Rate</th>
                <th style="width: 50px; text-align: center; border-bottom: 1px solid #000;">per</th>
                <th style="width: 120px; text-align: right; border-bottom: 1px solid #000; border-right: none;">Amount</th>
              </tr>
            </thead>
            <tbody>
              <!-- Dynamic Rows -->
              ${rowsHtml}
              
              <!-- Blank filling row to match height of standard Tally invoices -->
              ${minHeightRow}
              
              <!-- Subtotal Line -->
              <tr style="vertical-align: top;">
                <td style="border-right: 1px solid #000;"></td>
                <td style="border-right: 1px solid #000; text-align: right;"></td>
                <td style="border-right: 1px solid #000;"></td>
                <td style="border-right: 1px solid #000;"></td>
                <td style="border-right: 1px solid #000;"></td>
                <td style="border-right: 1px solid #000;"></td>
                <td style="text-align: right; font-weight: bold; border-top: 1px solid #000; border-bottom: 1px solid #000; font-family: monospace; border-right: none;">${formatIndianCurrency(subtotal)}</td>
              </tr>
              
              <!-- CGST, SGST, IGST, R/OFF Rows -->
              ${taxBreakdownRows}
              
              <!-- Grand Total Row -->
              <tr class="total-row">
                <td style="border-right: 1px solid #000;"></td>
                <td style="text-align: right; padding-right: 15px;">Total</td>
                <td style="border-right: 1px solid #000;"></td>
                <td style="text-align: right; font-weight: bold; font-family: monospace; border-right: 1px solid #000;">${totalQtySum} ${lastUnit}</td>
                <td style="border-right: 1px solid #000;"></td>
                <td style="border-right: 1px solid #000;"></td>
                <td style="text-align: right; font-size: 12px; border-right: none;"><strong>₹ ${formatIndianCurrency(grandTotalRounded)}</strong></td>
              </tr>
            </tbody>
          </table>
          
          <!-- Amount in Words -->
          <table class="info-table" style="border-top: none;">
            <tr>
              <td style="border-bottom: 1px solid #000; border-right: none; padding: 6px 8px;">
                <span class="summary-title-cell">Amount Chargeable (in words)</span>
                <strong style="font-size: 11px;">${wordsAmount}</strong>
                <span style="float: right; font-style: italic; font-size: 10px; font-weight: bold; margin-top: 2px;">E. & O.E</span>
              </td>
            </tr>
          </table>
          
          <!-- HSN Summary Table -->
          <table class="hsn-summary-table">
            <thead>
              ${hsnSummaryHeaderHtml}
            </thead>
            <tbody>
              ${hsnSummaryRowHtml}
            </tbody>
          </table>
          
          <!-- Tax in Words -->
          <table class="info-table" style="border-top: 1px solid #000; border-bottom: none;">
            <tr>
              <td style="border-bottom: 1px solid #000; border-right: none; font-size: 11px; padding: 6px 8px;">
                Tax Amount (in words) : <strong>${taxWordsAmount}</strong>
              </td>
            </tr>
          </table>
          
          <!-- Declarations & Signatures -->
          <table class="info-table" style="border-bottom: none;">
            <tr>
              <!-- Left Cell: PAN and Declaration -->
              <td rowspan="2" style="width: 50%; border-bottom: none; border-right: 1px solid #000; padding: 6px 8px;">
                Company's PAN &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: <strong>AAGCC3649G</strong><br><br>
                <strong style="text-decoration: underline; font-size: 10px;">Declaration:</strong><br>
                We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.
              </td>
              <!-- Right Top Cell: Bank Details -->
              <td style="width: 50%; border-bottom: 1px solid #000; border-right: none; padding: 6px 8px;">
                <strong>Company's Bank Details:</strong><br>
                A/c Holder's Name: <strong>CHOKHANI FROZEN FOODS PVT. LTD.</strong><br>
                Bank Name: <strong>HDFC BANK A/C</strong><br>
                A/c No.: <strong>50200106023370</strong><br>
                Branch & IFS Code: <strong>BHIWANI & HDFC0000479</strong>
              </td>
            </tr>
            <tr>
              <!-- Right Bottom Cell: Signatory -->
              <td style="width: 50%; border-bottom: none; border-right: none; height: 90px; vertical-align: top; position: relative; padding: 6px 8px;">
                <div style="font-size: 9px; font-weight: bold; text-transform: uppercase;">for CHOKHANI FROZEN FOODS PVT. LTD.</div>
                <div style="position: absolute; bottom: 8px; right: 8px; text-align: right; font-size: 9px; font-weight: bold;">
                  <br><br><br>
                  Authorised Signatory
                </div>
              </td>
            </tr>
          </table>
        </div>
        
        <!-- Footer Notes -->
        <div style="text-align: center; font-size: 10px; font-weight: bold; margin-top: 8px; text-transform: uppercase; letter-spacing: 0.5px;">SUBJECT TO BHIWANI JURISDICTION</div>
        <div style="text-align: center; font-size: 9px; font-weight: normal; margin-top: 2px; color: #444;">This is a Computer Generated Invoice</div>
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
    const yearlyStats = await dbGet(`
      WITH active_years AS (
        SELECT DISTINCT EXTRACT(YEAR FROM order_date)::int as yr
        FROM orders
        WHERE order_date IS NOT NULL
        ORDER BY yr DESC
        LIMIT 3
      ),
      years_array AS (
        SELECT array_agg(yr) as yrs FROM (SELECT yr FROM active_years ORDER BY yr ASC) t
      )
      SELECT 
        (SELECT yrs[1] FROM years_array) as y1,
        (SELECT yrs[2] FROM years_array) as y2,
        (SELECT yrs[3] FROM years_array) as y3,
        COALESCE(SUM(CASE WHEN EXTRACT(YEAR FROM order_date)::int = (SELECT yrs[1] FROM years_array) THEN total_amount ELSE 0 END), 0) as sales_y1,
        COALESCE(SUM(CASE WHEN EXTRACT(YEAR FROM order_date)::int = (SELECT yrs[2] FROM years_array) THEN total_amount ELSE 0 END), 0) as sales_y2,
        COALESCE(SUM(CASE WHEN EXTRACT(YEAR FROM order_date)::int = (SELECT yrs[3] FROM years_array) THEN total_amount ELSE 0 END), 0) as sales_y3,
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COALESCE(SUM(tax_amount), 0) as total_tax,
        COALESCE(COUNT(id), 0) as total_orders
      FROM orders
      WHERE status = 'COMPLETED'
    `);

    // Generate monthly series (last 12 months)
    const now = new Date();
    const monthlySeries = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthKey = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
      const monthLabel = d.toLocaleString('default', { month: 'short', year: 'numeric' });
      monthlySeries.push({ key: monthKey, label: monthLabel, revenue: 0, tax: 0, orderCount: 0 });
    }

    const monthlyStats = await dbAll(`
      SELECT 
        TO_CHAR(order_date, 'YYYY-MM') as key,
        COALESCE(SUM(total_amount), 0) as revenue,
        COALESCE(SUM(tax_amount), 0) as tax,
        COUNT(id) as order_count
      FROM orders
      WHERE status = 'COMPLETED'
      GROUP BY key
    `);
    
    monthlyStats.forEach(stat => {
      const item = monthlySeries.find(m => m.key === stat.key);
      if (item) {
        item.revenue = parseFloat(stat.revenue);
        item.tax = parseFloat(stat.tax);
        item.orderCount = parseInt(stat.order_count);
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

    // Compile distributor yearly comparison using the correct aggregation logic
    const distributorYearlyComparison = await dbAll(`
      WITH active_years AS (
        SELECT DISTINCT EXTRACT(YEAR FROM order_date)::int as yr
        FROM orders
        WHERE order_date IS NOT NULL
        ORDER BY yr DESC
        LIMIT 3
      ),
      years_array AS (
        SELECT array_agg(yr) as yrs FROM (SELECT yr FROM active_years ORDER BY yr ASC) t
      )
      SELECT 
        o.customer_name as name,
        d.location,
        COALESCE(SUM(CASE WHEN EXTRACT(YEAR FROM o.order_date)::int = (SELECT yrs[1] FROM years_array) THEN o.total_amount ELSE 0 END), 0) as sales_y1,
        COALESCE(SUM(CASE WHEN EXTRACT(YEAR FROM o.order_date)::int = (SELECT yrs[2] FROM years_array) THEN o.total_amount ELSE 0 END), 0) as sales_y2,
        COALESCE(SUM(CASE WHEN EXTRACT(YEAR FROM o.order_date)::int = (SELECT yrs[3] FROM years_array) THEN o.total_amount ELSE 0 END), 0) as sales_y3
      FROM orders o
      LEFT JOIN distributors d ON o.customer_name = d.name
      GROUP BY o.customer_name, d.location
      ORDER BY sales_y3 DESC
    `);

    res.json({
      summary: {
        totalRevenue: yearlyStats.total_revenue || 0,
        totalTax: yearlyStats.total_tax || 0,
        totalProfit: (yearlyStats.total_revenue || 0) * 0.35,
        totalOrders: parseInt(yearlyStats.total_orders || 0),
        salesY1: yearlyStats.sales_y1 || 0,
        salesY2: yearlyStats.sales_y2 || 0,
        salesY3: yearlyStats.sales_y3 || 0,
        y1: yearlyStats.y1,
        y2: yearlyStats.y2,
        y3: yearlyStats.y3
      },
      monthlySeries,
      yearlySeries: [
        yearlyStats.sales_y1 || 0,
        yearlyStats.sales_y2 || 0,
        yearlyStats.sales_y3 || 0
      ],
      topSellers,
      distributorYearlyComparison
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
// 🛠️ DISTRIBUTOR UPDATES & DELETIONS
// ==========================================

// PUT Update Distributor
app.put('/api/v1/distributors/:id', async (req, res) => {
  const { id } = req.params;
  const { name, location, gstin, phone } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Distributor name is required" });
  }
  try {
    const dist = await dbGet("SELECT * FROM distributors WHERE id = ?", [id]);
    if (!dist) {
      return res.status(404).json({ error: "Distributor not found" });
    }
    await dbRun(
      "UPDATE distributors SET name = ?, location = ?, gstin = ?, phone = ? WHERE id = ?",
      [name, location || '', gstin || '', phone || '', id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE Distributor Ledger
app.delete('/api/v1/distributors/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const dist = await dbGet("SELECT * FROM distributors WHERE id = ?", [id]);
    if (!dist) {
      return res.status(404).json({ error: "Distributor not found" });
    }
    await dbRun("DELETE FROM distributors WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 📦 FINISHED GOODS STOCK ADJUSTMENT
// ==========================================

// PUT Update Finished Good Stock
app.put('/api/v1/finished-goods/:id/stock', async (req, res) => {
  const { id } = req.params;
  const { stock_qty, user_role, user_name } = req.body;
  if (stock_qty === undefined || stock_qty < 0) {
    return res.status(400).json({ error: "stock_qty must be a non-negative integer" });
  }
  try {
    const fg = await dbGet("SELECT * FROM finished_goods WHERE id = ?", [id]);
    if (!fg) {
      return res.status(404).json({ error: "Finished good not found" });
    }

    await dbRun("UPDATE finished_goods SET stock_qty = ? WHERE id = ?", [stock_qty, id]);

    await logAudit(
      user_role || "ADMIN",
      user_name || "Manager",
      "STOCK_ADJUSTMENT",
      "finished_goods",
      id,
      { stock_qty: fg.stock_qty },
      { stock_qty: stock_qty }
    );

    broadcast("FINISHED_GOOD_STOCK_UPDATED", { name: fg.name, new_stock: stock_qty });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🛒 ORDER PAYMENT STATUS
// ==========================================

// PUT Update Order Payment Status
app.put('/api/v1/sales/orders/:id/payment', async (req, res) => {
  const { id } = req.params;
  const { payment_status } = req.body;
  if (!payment_status) {
    return res.status(400).json({ error: "payment_status is required" });
  }
  try {
    const order = await dbGet("SELECT * FROM orders WHERE id = ?", [id]);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    await dbRun("UPDATE orders SET payment_status = ? WHERE id = ?", [payment_status, id]);
    
    await logAudit(
      "SALES_AGENT",
      "System Agent",
      "ORDER_PAYMENT_STATUS_UPDATED",
      "orders",
      id,
      { payment_status: order.payment_status },
      { payment_status }
    );

    broadcast("ORDER_UPDATED", { order_id: id, payment_status });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 👷 WORKERS & ATTENDANCE SHIFTS
// ==========================================

// GET All Workers
app.get('/api/v1/workers', async (req, res) => {
  try {
    const workers = await dbAll("SELECT * FROM workers ORDER BY name ASC");
    res.json(workers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Register New Worker
app.post('/api/v1/workers', async (req, res) => {
  const { name, hourly_rate } = req.body;
  if (!name || hourly_rate === undefined) {
    return res.status(400).json({ error: "name and hourly_rate are required" });
  }
  try {
    const result = await dbRun("INSERT INTO workers (name, hourly_rate) VALUES (?, ?)", [name, hourly_rate]);
    res.json({ success: true, workerId: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE Remove Worker
app.delete('/api/v1/workers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await dbRun("DELETE FROM workers WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Clock In Worker
app.post('/api/v1/workers/clock-in', async (req, res) => {
  const { worker_id } = req.body;
  if (!worker_id) {
    return res.status(400).json({ error: "worker_id is required" });
  }
  try {
    const activeShift = await dbGet("SELECT * FROM worker_shifts WHERE worker_id = ? AND time_out IS NULL", [worker_id]);
    if (activeShift) {
      return res.status(400).json({ error: "Worker already has an active shift running" });
    }

    const worker = await dbGet("SELECT hourly_rate FROM workers WHERE id = ?", [worker_id]);
    if (!worker) {
      return res.status(404).json({ error: "Worker not found" });
    }

    const nowStr = new Date().toISOString();
    const result = await dbRun(
      "INSERT INTO worker_shifts (worker_id, time_in, hourly_rate, is_paid) VALUES (?, ?, ?, FALSE)",
      [worker_id, nowStr, worker.hourly_rate]
    );
    res.json({ success: true, shiftId: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT Clock Out Worker Shift
app.put('/api/v1/workers/shifts/:id/clock-out', async (req, res) => {
  const { id } = req.params;
  try {
    const shift = await dbGet("SELECT * FROM worker_shifts WHERE id = ?", [id]);
    if (!shift) {
      return res.status(404).json({ error: "Shift not found" });
    }
    if (shift.time_out) {
      return res.status(400).json({ error: "Shift is already clocked out" });
    }

    const now = new Date();
    const nowStr = now.toISOString();
    const timeIn = new Date(shift.time_in);
    const totalHours = (now - timeIn) / (1000 * 60 * 60);
    const paymentAmount = totalHours * shift.hourly_rate;

    await dbRun(
      "UPDATE worker_shifts SET time_out = ?, total_hours = ?, payment_amount = ? WHERE id = ?",
      [nowStr, totalHours, paymentAmount, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Fetch All Shifts Joined With Worker Name
app.get('/api/v1/workers/shifts', async (req, res) => {
  try {
    const shifts = await dbAll(`
      SELECT ws.*, w.name as worker_name 
      FROM worker_shifts ws
      JOIN workers w ON ws.worker_id = w.id
      ORDER BY ws.time_in DESC
    `);
    res.json(shifts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT Toggle Shift Paid Status
app.put('/api/v1/workers/shifts/:id/paid', async (req, res) => {
  const { id } = req.params;
  const { is_paid } = req.body;
  if (is_paid === undefined) {
    return res.status(400).json({ error: "is_paid parameter is required" });
  }
  try {
    await dbRun("UPDATE worker_shifts SET is_paid = ? WHERE id = ?", [is_paid, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE Shift Log
app.delete('/api/v1/workers/shifts/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await dbRun("DELETE FROM worker_shifts WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🥶 COLD ROOM BRIDGE CALCULATOR
// ==========================================

// POST Execute Calculator Production
app.post('/api/v1/production/execute-calculator', async (req, res) => {
  const { recipe_id, target_quantity, ingredients_override } = req.body;
  if (!recipe_id || !target_quantity || target_quantity <= 0) {
    return res.status(400).json({ error: "recipe_id and a positive target_quantity are required" });
  }

  try {
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

    const allocations = [];
    const now = new Date();
    const nowStr = now.toISOString().replace('T', ' ').substring(0, 19);

    for (let ing of ingredients) {
      const batches = await dbAll(`
        SELECT * FROM inventory_batches 
        WHERE raw_material_id = ? AND remaining_quantity > 0 AND expiry_date >= ?
        ORDER BY expiry_date ASC
      `, [ing.raw_material_id, nowStr]);

      const scaleFactor = target_quantity / recipe.yield_quantity;
      let requiredQty = ing.quantity_required * scaleFactor;
      if (ingredients_override && Array.isArray(ingredients_override)) {
        const override = ingredients_override.find(o => o.raw_material_id === ing.raw_material_id);
        if (override) {
          requiredQty = parseFloat(override.quantity_used);
        }
      }
      const totalRequired = requiredQty;
      
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
          error: `Insufficient stock under FEFO rules for ingredient '${ing.name}'. Required: ${totalRequired.toFixed(2)} ${ing.unit}, Available: ${availableQty.toFixed(2)} ${ing.unit}`
        });
      }

      allocations.push(...materialAllocations);
    }

    const yy = now.getFullYear().toString().slice(-2);
    const mm = (now.getMonth() + 1).toString().padStart(2, '0');
    const rand = Math.floor(1000 + Math.random() * 9000);
    const batch_code = `PB-${yy}${mm}-${rand}`;
    const expiryFinished = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const newBatchResult = await dbRun(
      "INSERT INTO production_batches (batch_code, recipe_id, flavor_name, status, quantity_produced, expiry_date) VALUES (?, ?, ?, ?, ?, ?)",
      [batch_code, recipe_id, recipe.name, 'COMPLETED', target_quantity, expiryFinished]
    );
    const productionBatchId = newBatchResult.lastID;

    for (let alloc of allocations) {
      const batchObj = await dbGet("SELECT * FROM inventory_batches WHERE id = ?", [alloc.inventory_batch_id]);
      const newRemaining = batchObj.remaining_quantity - alloc.quantity_used;
      await dbRun("UPDATE inventory_batches SET remaining_quantity = ? WHERE id = ?", [newRemaining, alloc.inventory_batch_id]);

      const rawMatObj = await dbGet("SELECT * FROM raw_materials WHERE id = ?", [alloc.raw_material_id]);
      const newRawStock = rawMatObj.current_stock - alloc.quantity_used;
      await dbRun("UPDATE raw_materials SET current_stock = ? WHERE id = ?", [newRawStock, alloc.raw_material_id]);

      await dbRun(
        "INSERT INTO batch_ingredients (production_batch_id, raw_material_id, inventory_batch_id, quantity_used) VALUES (?, ?, ?, ?)",
        [productionBatchId, alloc.raw_material_id, alloc.inventory_batch_id, alloc.quantity_used]
      );
    }

    const finishedGood = await dbGet("SELECT * FROM finished_goods WHERE name = ?", [recipe.name]);
    if (finishedGood) {
      const newStock = finishedGood.stock_qty + target_quantity;
      await dbRun("UPDATE finished_goods SET stock_qty = ? WHERE id = ?", [newStock, finishedGood.id]);
      
      await logAudit(
        "PRODUCTION_SUPERVISOR",
        "System Calculator",
        "STOCK_ADJUSTMENT",
        "finished_goods",
        finishedGood.id,
        { stock_qty: finishedGood.stock_qty },
        { stock_qty: newStock }
      );
    }

    await logAudit(
      "PRODUCTION_SUPERVISOR",
      "System Calculator",
      "BATCH_CREATED",
      "production_batches",
      productionBatchId,
      null,
      { batch_code, recipe: recipe.name, status: 'COMPLETED', quantity_produced: target_quantity, ingredients_allocated: allocations.length }
    );

    broadcast("PRODUCTION_STARTED", { batch_code, flavor_name: recipe.name });
    if (finishedGood) {
      broadcast("FINISHED_GOOD_STOCK_UPDATED", { name: recipe.name, new_stock: finishedGood.stock_qty + target_quantity });
    }
    
    res.json({ success: true, productionBatchId, batch_code, flavor_name: recipe.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE Cancel Order and Revert Inventory
app.delete('/api/v1/sales/orders/:id', async (req, res) => {
  const { id } = req.params;
  const { user_role, user_name } = req.body || {};
  try {
    const order = await dbGet("SELECT * FROM orders WHERE id = ?", [id]);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const items = await dbAll("SELECT * FROM order_items WHERE order_id = ?", [id]);

    // Restore finished goods stock
    for (let item of items) {
      const fg = await dbGet("SELECT * FROM finished_goods WHERE name = ?", [item.product_name]);
      if (fg) {
        const newStock = fg.stock_qty + item.quantity;
        await dbRun("UPDATE finished_goods SET stock_qty = ? WHERE id = ?", [newStock, fg.id]);
        broadcast("FINISHED_GOOD_STOCK_UPDATED", { name: fg.name, new_stock: newStock });
      }
    }

    // Delete order (cascades to order_items)
    await dbRun("DELETE FROM orders WHERE id = ?", [id]);

    await logAudit(
      user_role || "SALES_AGENT",
      user_name || "Sales Desk",
      "BILL_CANCELLED",
      "orders",
      id,
      { order_code: order.order_code, status: order.status },
      { status: 'CANCELLED' }
    );

    broadcast("ORDER_CANCELLED", { order_id: id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Distributor Dashboard Analytics
app.get('/api/v1/dashboard/distributors/:name', async (req, res) => {
  const { name } = req.params;
  try {
    const orders = await dbAll(`
      SELECT o.* FROM orders o 
      WHERE o.customer_name = ?
      ORDER BY o.order_date DESC
    `, [name]);

    if (orders.length > 0) {
      const orderIds = orders.map(o => o.id);
      const allItems = await dbAll("SELECT * FROM order_items WHERE order_id = ANY(?)", [orderIds]);
      const itemsMap = {};
      allItems.forEach(item => {
        if (!itemsMap[item.order_id]) {
          itemsMap[item.order_id] = [];
        }
        itemsMap[item.order_id].push(item);
      });
      orders.forEach(order => {
        order.items = itemsMap[order.id] || [];
      });
    }

    const dist = await dbGet("SELECT * FROM distributors WHERE name = ?", [name]);

    let totalRevenue = 0;
    let totalTax = 0;
    let totalQty = 0;
    let totalOrders = orders.length;

    orders.forEach(order => {
      totalRevenue += order.total_amount;
      totalTax += order.tax_amount;
      if (order.items) {
        order.items.forEach(item => {
          totalQty += item.quantity;
        });
      }
    });

    const monthlySeriesMap = {};
    orders.forEach(order => {
      if (order.order_date) {
        const d = new Date(order.order_date);
        const monthKey = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
        if (!monthlySeriesMap[monthKey]) {
          monthlySeriesMap[monthKey] = { month: monthKey, totalSales: 0, orderCount: 0 };
        }
        monthlySeriesMap[monthKey].totalSales += order.total_amount;
        monthlySeriesMap[monthKey].orderCount += 1;
      }
    });

    const monthlySeries = Object.values(monthlySeriesMap).sort((a, b) => a.month.localeCompare(b.month));

    res.json({
      name,
      summary: {
        totalRevenue,
        totalTax,
        totalQty,
        totalOrders
      },
      orders,
      monthlySeries
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Distributor YoY Comparison Timeline
app.get('/api/v1/dashboard/distributors/:name/yoy-comparison', async (req, res) => {
  const { name } = req.params;
  try {
    const activeYears = await dbAll(`
      SELECT DISTINCT EXTRACT(YEAR FROM order_date)::int as yr
      FROM orders
      WHERE order_date IS NOT NULL
      ORDER BY yr DESC
      LIMIT 2
    `);
    
    const sortedYears = activeYears.map(r => r.yr).sort((a, b) => a - b);
    const pastYear = sortedYears[0] || (new Date().getFullYear() - 1);
    const currentYear = sortedYears[1] || new Date().getFullYear();

    const monthlyStats = await dbAll(`
      SELECT 
        EXTRACT(MONTH FROM o.order_date)::int as month,
        COALESCE(SUM(CASE WHEN EXTRACT(YEAR FROM o.order_date)::int = ? THEN o.total_amount ELSE 0 END), 0) as sales_past,
        COALESCE(SUM(CASE WHEN EXTRACT(YEAR FROM o.order_date)::int = ? THEN o.total_amount ELSE 0 END), 0) as sales_current
      FROM orders o
      WHERE o.customer_name = ?
      GROUP BY month
      ORDER BY month ASC
    `, [pastYear, currentYear, name]);

    const monthlyPast = Array(12).fill(0);
    const monthlyCurrent = Array(12).fill(0);
    let totalPast = 0;
    let totalCurrent = 0;

    monthlyStats.forEach(stat => {
      const mIdx = stat.month - 1;
      if (mIdx >= 0 && mIdx < 12) {
        monthlyPast[mIdx] = parseFloat(stat.sales_past);
        monthlyCurrent[mIdx] = parseFloat(stat.sales_current);
        totalPast += parseFloat(stat.sales_past);
        totalCurrent += parseFloat(stat.sales_current);
      }
    });

    res.json({
      name,
      pastYear,
      currentYear,
      monthlyPast,
      monthlyCurrent,
      totalPast,
      totalCurrent
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Distributor Statement of Account HTML
app.get('/api/v1/sales/distributors/:name/invoice-history', async (req, res) => {
  const { name } = req.params;
  try {
    const orders = await dbAll(`
      SELECT o.* FROM orders o 
      WHERE o.customer_name = ?
      ORDER BY o.order_date DESC
    `, [name]);

    if (orders.length > 0) {
      const orderIds = orders.map(o => o.id);
      const allItems = await dbAll("SELECT * FROM order_items WHERE order_id = ANY(?)", [orderIds]);
      const itemsMap = {};
      allItems.forEach(item => {
        if (!itemsMap[item.order_id]) {
          itemsMap[item.order_id] = [];
        }
        itemsMap[item.order_id].push(item);
      });
      orders.forEach(order => {
        order.items = itemsMap[order.id] || [];
      });
    }

    const dist = await dbGet("SELECT * FROM distributors WHERE name = ?", [name]);

    let totalRevenue = 0;
    let totalTax = 0;
    let totalQty = 0;
    let totalOrders = orders.length;

    orders.forEach(order => {
      totalRevenue += order.total_amount;
      totalTax += order.tax_amount;
      if (order.items) {
        order.items.forEach(item => {
          totalQty += item.quantity;
        });
      }
    });

    let rowsHtml = '';
    orders.forEach((ord, index) => {
      let itemsStr = '';
      if (ord.items) {
        itemsStr = ord.items.map(item => `${item.product_name} (${item.quantity})`).join(', ');
      }
      rowsHtml += `
        <tr>
          <td>${index + 1}</td>
          <td>${ord.order_code}</td>
          <td>${ord.order_date ? new Date(ord.order_date).toLocaleDateString() : ''}</td>
          <td>${itemsStr}</td>
          <td>₹${ord.tax_amount.toFixed(2)}</td>
          <td>₹${ord.total_amount.toFixed(2)}</td>
        </tr>
      `;
    });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Distributor Statement - ${name}</title>
        <style>
          body { font-family: 'Inter', sans-serif; color: #333; margin: 20px; }
          .container { max-width: 800px; margin: auto; padding: 30px; border: 1px solid #eee; }
          .header { display: flex; justify-content: space-between; border-bottom: 2px solid #38bdf8; padding-bottom: 20px; margin-bottom: 20px; }
          .title { font-size: 24px; font-weight: bold; color: #1e3a8a; }
          .summary { display: flex; justify-content: space-between; background: #f8fafc; padding: 15px; margin-bottom: 30px; border-radius: 4px; }
          table { width: 100%; border-collapse: collapse; text-align: left; }
          th { background: #f1f5f9; padding: 10px; font-weight: 600; border-bottom: 2px solid #cbd5e1; }
          td { padding: 10px; border-bottom: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div>
              <div class="title">Distributor Purchase Statement</div>
              <div>Distributor: <strong>${name}</strong></div>
              <div>Location: ${dist ? dist.location || 'N/A' : 'N/A'}</div>
            </div>
            <div style="text-align: right;">
              <div>Stitch Ice Cream Factory</div>
              <div>Statement Generated: ${new Date().toLocaleDateString()}</div>
            </div>
          </div>

          <div class="summary">
            <div><strong>Total Orders:</strong> ${totalOrders}</div>
            <div><strong>Total Purchased Qty:</strong> ${totalQty} pcs</div>
            <div><strong>Total Tax Paid:</strong> ₹${totalTax.toFixed(2)}</div>
            <div><strong>Total Spend:</strong> ₹${totalRevenue.toFixed(2)}</div>
          </div>

          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Order Code</th>
                <th>Date</th>
                <th>Items (Qty)</th>
                <th>Tax</th>
                <th>Total Amount</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </body>
      </html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).send(`<h1>Error generating statement</h1><p>${err.message}</p>`);
  }
});

// GET Production Analytics for a Flavor
app.get('/api/v1/production/analytics/:name', async (req, res) => {
  const { name } = req.params;
  try {
    const batchesRes = await dbGet("SELECT COUNT(*) as count FROM production_batches WHERE flavor_name = ? AND status = 'COMPLETED'", [name]);
    const qtyRes = await dbGet("SELECT SUM(quantity_produced) as total FROM production_batches WHERE flavor_name = ? AND status = 'COMPLETED'", [name]);
    const materials = await dbAll(`
      SELECT rm.id as raw_material_id, rm.SKU as SKU, rm.name, SUM(bi.quantity_used) as total_used, rm.unit
      FROM production_batches pb
      JOIN batch_ingredients bi ON pb.id = bi.production_batch_id
      JOIN raw_materials rm ON bi.raw_material_id = rm.id
      WHERE pb.flavor_name = ? AND pb.status = 'COMPLETED'
      GROUP BY rm.id, rm.SKU, rm.name, rm.unit
    `, [name]);

    res.json({
      totalBatches: parseInt(batchesRes ? batchesRes.count : 0) || 0,
      totalFinishedProductFormed: parseFloat(qtyRes ? qtyRes.total : 0) || 0,
      actualMaterialsUsed: materials
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
