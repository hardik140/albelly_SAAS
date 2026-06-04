Product Requirement Document (PRD)

1. Executive Summary & Objectives
The goal is to build a specialized, multi-tenant SaaS ERP tailored for small-to-medium ice cream manufacturing businesses. Ice cream production involves sensitive cold-chain logistics, strict batch/recipe management, and rapid inventory turnover.
This platform will provide real-time visibility into the entire lifecycle—from raw milk and stabilization agents to the final frozen scoop—ensuring compliance, reducing waste, and streamlining sales.

2. User Personas & Role-Based Access Control (RBAC)
To satisfy the Role-based access control and In-Out time manager requirements, the system defines four core roles:
Role | Primary Responsibilities | Access Level
Admin / Owner | High-level analytics, financial overview, system configuration, audit logs. | Full Read/Write/Delete
Inventory Manager | Raw material sourcing, expiry tracking, finished goods logging. | Inventory & Vendor Modules
Production Supervisor | Batch creation, recipe management, machine/line assignment. | Production & Batch Modules
Sales & Dispatch Agent | Order creation, billing, transport dispatch, gate in-out logging. | Sales & Logistics Modules

3. Epics & Feature Requirements
Epic 1: Inventory & Expiry Management (Raw & Finished)
FR-1.1: Track raw materials (milk, cream, sugar, emulsifiers, packaging) by weight/volume.
FR-1.2: Batch-wise Expiry Tracking: Enforce First-Expired, First-Out (FEFO) alerts for perishable dairy inputs.
FR-1.3: Finished Goods Inventory: Auto-update stock levels of specific ice cream flavors, brick sizes, and cones upon production completion.

Epic 2: Production Tracking & Recipe Management
FR-2.1: Define standard recipes (e.g., 100L of Vanilla Mix requires X kg Cream, Y kg SMP).
FR-2.2: Launch "Production Batches" that automatically deduct raw materials from stock based on the recipe.
FR-2.3: Track aging times (e.g., mix must age for 4–12 hours) and freezing stages.

Epic 3: Sales, Billing & Dispatch Management
FR-3.1: Interactive Sales Interface: A grid-based or quick-search POS/Sales dashboard for booking distributor orders.
FR-3.2: Billing Engine: Generate GST/tax-compliant PDF invoices instantly upon order confirmation.
FR-3.3: Transport Dispatch: Log delivery vehicle numbers, driver details, and target temperature settings for the cold chain.
FR-3.4: In-Out Time Manager: Digital logbook to record the exact timestamp a delivery vehicle or raw material truck enters and exits the factory gate.

Epic 4: Traceability & Auditing
FR-4.1: End-to-End Traceability: Ability to look up a finished ice cream batch number and instantly see which specific supplier batches of milk or flavorings went into it.
FR-4.2: System Audit Log: Immutable ledger recording which user modified inventory, approved a batch, or altered an invoice.

4. User Interface Wireframe Concept (Sales Dashboard)
+-----------------------------------------------------------------------+
|  [Search Flavors...]  | Category: [Bricks] [Cones] [Tubs]             |
+-----------------------------------------------------------------------+
| +-------------------+  +-------------------+  +-------------------+   |
| | Vanilla 1L Brick  |  | Choco Cone 100ml  |  | Mango Tub 5L      |   |
| | Stock: 120 pcs    |  | Stock: 450 pcs    |  | Stock: 14 pcs     |   |
| | [Qty: 5 ] [Add+]  |  | [Qty: 50] [Add+]  |  | [Qty: 1 ] [Add+]  |   |
| +-------------------+  +-------------------+  +-------------------+   |
+-----------------------------------------------------------------------+
| ORDER SUMMARY                                      | CUSTOMER INFO    |
| - 5x Vanilla 1L Brick   : $25.00                   | Name: ABC Distrib|
| - 50x Choco Cone        : $50.00                   |                  |
| Total: $75.00  [Generate Bill & Dispatch]          |                  |
+-----------------------------------------------------------------------+

Technical Requirement Document (TRD)

1. System Architecture & Tech Stack
To ensure scalability as a SaaS application, a robust, modular stack is recommended:
Frontend: React.js or Next.js (with TailwindCSS for a clean, scannable layout; Shadcn/ui or Material UI for the interactive sales grid).
Backend: Node.js (TypeScript) with Express or NestJS for structured API design.
Database: PostgreSQL (Relational integrity is crucial for handling complex recipes, inventory dependencies, and financial billing).
Caching/Real-time: Redis (for session management and real-time factory dashboard metrics).

2. Database Schema (Core Entities)
Below is the relational data model mapping the critical requirements.
+-------------------+       +--------------------+       +-------------------+
|  Raw_Materials    |       | Batch_Ingredients  |       | Production_Batch  |
|-------------------|       |--------------------|       |-------------------|
| id (PK)           |<-----+| id (PK)            |------>| id (PK)           |
| name              |       | batch_id (FK)      |       | batch_code (Unique|
| SKU               |       | raw_material_id(FK)|       | flavor_id         |
| current_stock     |       | quantity_used      |       | status (Aging/Mfg)|
+-------------------+       +--------------------+       | expiry_date       |
                                                         +-------------------+
                                                                   |
+-------------------+       +--------------------+                 |
|  Gate_Log         |       | Dispatch_Log       |                 |
|-------------------|       |--------------------|                 |
| id (PK)           |       | id (PK)            |                 |
| vehicle_no        |       | order_id (FK)      |                 |
| driver_name       |       | batch_id (FK) -----'                 |
| type (IN / OUT)   |       | driver_details     |
| timestamp         |       | cold_chain_temp    |
+-------------------+       +--------------------+

Key Data Tables Structure
inventory_batches (Expiry Tracking)
SQL:
CREATE TABLE inventory_batches (
    id SERIAL PRIMARY KEY,
    raw_material_id INT REFERENCES raw_materials(id),
    batch_number VARCHAR(50) NOT NULL,
    quantity_received NUMERIC(10,2),
    remaining_quantity NUMERIC(10,2),
    received_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expiry_date TIMESTAMP NOT NULL
);

gate_logs (In-Out Time Manager)
SQL:
CREATE TABLE gate_logs (
    id SERIAL PRIMARY KEY,
    vehicle_number VARCHAR(20) NOT NULL,
    driver_name VARCHAR(100),
    purpose VARCHAR(255), -- e.g., "Raw Material Delivery", "Sales Dispatch"
    time_in TIMESTAMP NOT NULL,
    time_out TIMESTAMP
);

audit_trails (Traceability)
SQL:
CREATE TABLE audit_trails (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    action VARCHAR(100), -- e.g., "STOCK_DECREMENT", "BILL_GENERATED"
    table_name VARCHAR(50),
    record_id INT,
    old_value JSONB,
    new_value JSONB,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

3. Core API Endpoints
📦 Inventory & Production
POST /api/v1/inventory/raw-materials -> Add new raw stock with expiry.
POST /api/v1/production/start -> Triggers recipe deduction logic. Checks if required raw ingredients exist using FEFO guidelines; if valid, locks the materials and generates a new production batch ID.

💰 Sales & Billing
POST /api/v1/sales/orders -> Processes payload from the interactive sales screen.
GET /api/v1/sales/orders/:id/invoice -> Compiles order details, applies taxes, and streams a PDF back to the client using a library like pdfkit or puppeteer.

🚛 Gate & Logistics
POST /api/v1/logistics/gate-in -> Creates a log entry with time_in.
PUT /api/v1/logistics/gate-out/:log_id -> Updates time_out, finalizing the vehicle duration check.

4. Key Engineering Challenges & Solutions
Challenge 1: Ensuring Data Auditability
Solution: Use PostgreSQL Database Triggers or a centralized application middleware that catches every write operation. It logs the exact change payload (old_value and new_value) into the audit_trails table. Users can never edit this table.

Challenge 2: Real-time "What's Going On" Factory Analytics
Solution: Build a central dashboard using WebSockets (Socket.io). When a production supervisor updates a batch from "Aging" to "Churning/Freezing", the event emits to the admin dashboard instantly without requiring manual page refreshes.
