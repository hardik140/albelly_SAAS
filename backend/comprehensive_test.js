const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set in .env!");
  process.exit(1);
}

const pool = new Pool({
  connectionString: connectionString,
  ssl: connectionString && connectionString.includes('supabase.co') ? { rejectUnauthorized: false } : false
});

const BASE_URL = 'http://localhost:3000/api/v1';

async function runTests() {
  console.log("==========================================================");
  console.log("🚀 STARTING ERP SYSTEM COMPREHENSIVE INTEGRATION TESTS");
  console.log("==========================================================");

  let successCount = 0;
  let failureCount = 0;

  async function assertTest(name, fn) {
    try {
      await fn();
      console.log(`✅ [SUCCESS] ${name}`);
      successCount++;
    } catch (err) {
      console.error(`❌ [FAILURE] ${name}`);
      console.error(`   Reason: ${err.message}`);
      failureCount++;
    }
  }

  // State holders for cleanup
  let testDistributorId = null;
  let testMaterialId = null;
  let testGoodId = null;
  let testWorkerId = null;
  let testShiftId = null;
  let testOrderIds = [];

  // Helper to fetch JSON
  async function apiFetch(path, options = {}) {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`API returned HTTP ${res.status}: ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      return text; // Return text if not JSON
    }
  }

  // 1. DISTRIBUTOR REGISTRATION TEST
  await assertTest("Distributor Registration", async () => {
    const res = await apiFetch("/distributors", {
      method: "POST",
      body: JSON.stringify({
        name: "TEST-DISTRIBUTOR",
        location: "Test City, TS",
        gstin: "29AAAAA1111A1Z1",
        user_role: "ADMIN",
        user_name: "Test Runner"
      })
    });
    if (!res.success || !res.distributorId) {
      throw new Error("Failed to register distributor");
    }
    testDistributorId = res.distributorId;
  });

  // 2. RAW MATERIAL RESTOCKING & TYPE REGISTRATION
  await assertTest("Raw Material Type Registration & Restocking", async () => {
    // Add raw material type
    const regRes = await apiFetch("/inventory/raw-materials", {
      method: "POST",
      body: JSON.stringify({
        name: "TEST-RAW-MAT",
        SKU: "RM-TEST-999",
        unit: "L",
        quantity: 50.0,
        unit_price: 120.0,
        expiry_date: "2028-12-31"
      })
    });
    if (!regRes.success) {
      throw new Error("Failed to register raw material lot");
    }
    
    // Query db directly to find its ID
    const dbRes = await pool.query("SELECT id FROM raw_materials WHERE SKU = 'RM-TEST-999'");
    if (dbRes.rows.length === 0) {
      throw new Error("Could not find registered raw material in database");
    }
    testMaterialId = dbRes.rows[0].id;
  });

  // 3. FINISHED PRODUCT CATALOG REGISTRATION & STOCK ADJUSTMENT
  await assertTest("Finished Product Catalog Management & Stock Adjustment", async () => {
    // Register product
    const regRes = await apiFetch("/finished-goods", {
      method: "POST",
      body: JSON.stringify({
        name: "TEST-FINISHED-GOOD",
        SKU: "FG-TEST-888",
        price: 150.0,
        stock_qty: 20,
        unit: "pcs"
      })
    });
    
    // Find ID
    const dbRes = await pool.query("SELECT id FROM finished_goods WHERE SKU = 'FG-TEST-888'");
    if (dbRes.rows.length === 0) {
      throw new Error("Could not find registered finished good in database");
    }
    testGoodId = dbRes.rows[0].id;

    // Adjust stock manually
    const adjRes = await apiFetch(`/finished-goods/${testGoodId}/stock`, {
      method: "PUT",
      body: JSON.stringify({
        stock_qty: 30,
        user_role: "ADMIN",
        user_name: "Test Runner"
      })
    });
    if (!adjRes.success) {
      throw new Error("Stock adjustment endpoint failed");
    }

    // Verify stock is now 30
    const checkRes = await pool.query("SELECT stock_qty FROM finished_goods WHERE id = $1", [testGoodId]);
    if (checkRes.rows[0].stock_qty !== 30) {
      throw new Error(`Expected stock quantity of 30, got ${checkRes.rows[0].stock_qty}`);
    }
  });

  // 4. WORKER REGISTRATION, CLOCK-IN, CLOCK-OUT, AND PAYROLL
  await assertTest("Worker Attendance & Shifts Lifecycle", async () => {
    // Register worker
    const regRes = await apiFetch("/workers", {
      method: "POST",
      body: JSON.stringify({
        name: "TEST-WORKER",
        hourly_rate: 200.0
      })
    });
    if (!regRes.success || !regRes.workerId) {
      throw new Error("Failed to register worker");
    }
    testWorkerId = regRes.workerId;

    // Clock in
    const clockInRes = await apiFetch("/workers/clock-in", {
      method: "POST",
      body: JSON.stringify({
        worker_id: testWorkerId
      })
    });
    if (!clockInRes.success || !clockInRes.shiftId) {
      throw new Error("Failed to clock in worker");
    }
    testShiftId = clockInRes.shiftId;

    // Wait 500ms to allow a slight delay for duration calculation
    await new Promise(resolve => setTimeout(resolve, 500));

    // Clock out
    const clockOutRes = await apiFetch(`/workers/shifts/${testShiftId}/clock-out`, {
      method: "PUT"
    });
    if (!clockOutRes.success) {
      throw new Error("Failed to clock out worker");
    }

    // Toggle shift payment
    const toggleRes = await apiFetch(`/workers/shifts/${testShiftId}/paid`, {
      method: "PUT",
      body: JSON.stringify({ is_paid: true })
    });
    if (!toggleRes.success) {
      throw new Error("Failed to toggle shift payment status");
    }
    
    // Verify shift is paid in DB
    const shiftCheck = await pool.query("SELECT is_paid FROM worker_shifts WHERE id = $1", [testShiftId]);
    if (!shiftCheck.rows[0].is_paid) {
      throw new Error("Expected shift paid status to be true after toggle");
    }
  });

  // 5. POS CHECKOUT WITH GST INVOICE TEST
  await assertTest("POS Checkout with GST Invoice", async () => {
    const res = await apiFetch("/sales/orders", {
      method: "POST",
      body: JSON.stringify({
        customer_name: "TEST-DISTRIBUTOR",
        items: [
          { name: "TEST-FINISHED-GOOD", quantity: 5, price: 150.0 }
        ],
        include_gst: true,
        user_role: "SALES_AGENT",
        user_name: "Test Runner"
      })
    });
    if (!res.success || !res.orderId) {
      throw new Error("Failed to checkout order with GST");
    }
    testOrderIds.push(res.orderId);

    // Verify stock deduction (30 - 5 = 25)
    const stockCheck = await pool.query("SELECT stock_qty FROM finished_goods WHERE id = $1", [testGoodId]);
    if (stockCheck.rows[0].stock_qty !== 25) {
      throw new Error(`Expected remaining stock of 25, got ${stockCheck.rows[0].stock_qty}`);
    }

    // Verify order tax_amount is non-zero
    const orderCheck = await pool.query("SELECT tax_amount, gst_rate FROM orders WHERE id = $1", [res.orderId]);
    if (parseFloat(orderCheck.rows[0].tax_amount) <= 0 || parseFloat(orderCheck.rows[0].gst_rate) <= 0) {
      throw new Error(`Expected positive tax and gst_rate, got tax_amount=${orderCheck.rows[0].tax_amount}, gst_rate=${orderCheck.rows[0].gst_rate}`);
    }

    // Verify Invoice HTML contains TAX INVOICE and GSTIN
    const invoiceHtml = await apiFetch(`/sales/orders/${res.orderId}/invoice`);
    if (!invoiceHtml.includes("TAX INVOICE") || !invoiceHtml.includes("GSTIN: 29AAAAA1111A1Z1")) {
      throw new Error("GST Invoice HTML does not contain TAX INVOICE title or GSTIN text");
    }
  });

  // 6. POS CHECKOUT WITHOUT GST BILL TEST
  await assertTest("POS Checkout with Non-GST Bill", async () => {
    const res = await apiFetch("/sales/orders", {
      method: "POST",
      body: JSON.stringify({
        customer_name: "TEST-DISTRIBUTOR",
        items: [
          { name: "TEST-FINISHED-GOOD", quantity: 3, price: 150.0 }
        ],
        include_gst: false,
        user_role: "SALES_AGENT",
        user_name: "Test Runner"
      })
    });
    if (!res.success || !res.orderId) {
      throw new Error("Failed to checkout order without GST");
    }
    testOrderIds.push(res.orderId);

    // Verify stock deduction (25 - 3 = 22)
    const stockCheck = await pool.query("SELECT stock_qty FROM finished_goods WHERE id = $1", [testGoodId]);
    if (stockCheck.rows[0].stock_qty !== 22) {
      throw new Error(`Expected remaining stock of 22, got ${stockCheck.rows[0].stock_qty}`);
    }

    // Verify order tax_amount is exactly 0
    const orderCheck = await pool.query("SELECT tax_amount, gst_rate FROM orders WHERE id = $1", [res.orderId]);
    if (parseFloat(orderCheck.rows[0].tax_amount) !== 0 || parseFloat(orderCheck.rows[0].gst_rate) !== 0) {
      throw new Error(`Expected zero tax and gst_rate, got tax_amount=${orderCheck.rows[0].tax_amount}, gst_rate=${orderCheck.rows[0].gst_rate}`);
    }

    // Verify Invoice HTML contains RETAIL BILL / RECEIPT and does NOT contain GSTIN
    const invoiceHtml = await apiFetch(`/sales/orders/${res.orderId}/invoice`);
    if (!invoiceHtml.includes("RETAIL BILL / RECEIPT")) {
      throw new Error("Non-GST Invoice HTML does not contain RETAIL BILL / RECEIPT title");
    }
    if (invoiceHtml.includes("GSTIN: 29AAAAA1111A1Z1")) {
      throw new Error("Non-GST Invoice HTML should not contain GSTIN text");
    }
  });

  // 6.5. CANCEL SALES ORDER AND REVERT INVENTORY STOCK TEST
  await assertTest("POS Order Cancellation & Stock Restoration", async () => {
    // 1. Create order for 4 items
    const res = await apiFetch("/sales/orders", {
      method: "POST",
      body: JSON.stringify({
        customer_name: "TEST-DISTRIBUTOR",
        items: [
          { name: "TEST-FINISHED-GOOD", quantity: 4, price: 150.0 }
        ],
        include_gst: false,
        user_role: "SALES_AGENT",
        user_name: "Test Runner"
      })
    });
    if (!res.success || !res.orderId) {
      throw new Error("Failed to checkout cancellation test order");
    }

    // Verify stock is now 18 (22 - 4)
    const stockCheckMid = await pool.query("SELECT stock_qty FROM finished_goods WHERE id = $1", [testGoodId]);
    if (stockCheckMid.rows[0].stock_qty !== 18) {
      throw new Error(`Expected mid-test stock of 18, got ${stockCheckMid.rows[0].stock_qty}`);
    }

    // 2. Cancel the order
    const cancelRes = await apiFetch(`/sales/orders/${res.orderId}`, {
      method: "DELETE",
      body: JSON.stringify({
        user_role: "SALES_AGENT",
        user_name: "Test Runner"
      })
    });
    if (!cancelRes.success) {
      throw new Error("Failed to call cancel order API: " + cancelRes.error);
    }

    // 3. Verify stock is restored to 22
    const stockCheckEnd = await pool.query("SELECT stock_qty FROM finished_goods WHERE id = $1", [testGoodId]);
    if (stockCheckEnd.rows[0].stock_qty !== 22) {
      throw new Error(`Expected restored stock of 22, got ${stockCheckEnd.rows[0].stock_qty}`);
    }
  });

  // 7. DISTRIBUTOR PERFORMANCE ANALYTICS & ACCOUNT STATEMENT TESTS
  await assertTest("Distributor Performance & Account Statements APIs", async () => {
    // Analytics
    const analytics = await apiFetch(`/dashboard/distributors/TEST-DISTRIBUTOR`);
    if (analytics.name !== "TEST-DISTRIBUTOR" || analytics.summary.totalOrders !== 2) {
      throw new Error("Incorrect distributor analytics aggregated");
    }

    // Purchase history / statement
    const statementHtml = await apiFetch(`/sales/distributors/TEST-DISTRIBUTOR/invoice-history`);
    if (!statementHtml.includes("Distributor Purchase Statement") || !statementHtml.includes("TEST-DISTRIBUTOR")) {
      throw new Error("Account statement html missing headers or distributor name");
    }
  });

  // ==========================================================
  // CLEANUP RUNNER
  // ==========================================================
  console.log("\n🧹 Cleaning up test data from database...");
  try {
    if (testOrderIds.length > 0) {
      // Deleting order items via Cascade is handled, but let's delete orders
      await pool.query("DELETE FROM orders WHERE id = ANY($1)", [testOrderIds]);
    }
    if (testShiftId) {
      await pool.query("DELETE FROM worker_shifts WHERE id = $1", [testShiftId]);
    }
    if (testWorkerId) {
      await pool.query("DELETE FROM workers WHERE id = $1", [testWorkerId]);
    }
    if (testGoodId) {
      await pool.query("DELETE FROM finished_goods WHERE id = $1", [testGoodId]);
    }
    if (testMaterialId) {
      // Delete from inventory_batches first, then raw_materials
      await pool.query("DELETE FROM inventory_batches WHERE raw_material_id = $1", [testMaterialId]);
      await pool.query("DELETE FROM raw_materials WHERE id = $1", [testMaterialId]);
    }
    if (testDistributorId) {
      await pool.query("DELETE FROM distributors WHERE id = $1", [testDistributorId]);
    }
    console.log("✅ Database cleanup complete.");
  } catch (cleanErr) {
    console.error("⚠️ Database cleanup encountered errors:", cleanErr.message);
  }

  // Closing pool
  await pool.end();

  console.log("\n==========================================================");
  console.log("📊 INTEGRATION TESTS EXECUTION SUMMARY:");
  console.log(`   Passed tests: ${successCount}`);
  console.log(`   Failed tests: ${failureCount}`);
  console.log("==========================================================");

  if (failureCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests();
