# Deployment Guide

This repository runs as a single Node.js backend service that also serves the frontend static files.

## 1) Create PostgreSQL Database

Create a PostgreSQL instance (Supabase or any managed PostgreSQL provider) and copy its connection string.

## 2) Deploy Backend Service

Deploy the `/home/runner/work/albelly_ERP/albelly_ERP/hardik140/albelly_ERP/backend` folder as a Node.js web service.

- Install command: `npm install`
- Start command: `npm start` (or `node server.js`)

## 3) Configure Environment Variables

Set the following environment variables in your hosting platform:

- `DATABASE_URL` (required)
- `SUPABASE_URL` (required only if using Supabase Auth token verification)
- `SUPABASE_ANON_KEY` (required only if using Supabase Auth token verification)
- `PORT` (optional; many providers inject this automatically)

Use `/home/runner/work/albelly_ERP/albelly_ERP/hardik140/albelly_ERP/backend/.env.example` as reference.

## 4) First Boot Behavior

On startup, the backend initializes schema and seed data through `initDb()` in `backend/database.js`.

## 5) Validate Deployment

After deploy:

1. Open `/` to verify frontend loads.
2. Check key API paths (for example):
   - `/api/v1/inventory/raw-materials`
   - `/api/v1/sales/orders`
3. Inspect platform logs for database or auth errors.

## 6) Domain and HTTPS

Attach a custom domain and enable HTTPS/TLS using your host's managed certificate settings.
