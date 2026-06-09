const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'khezwo.db');
const db = new sqlite3.Database(dbPath);

db.run('PRAGMA foreign_keys = ON');

db.serialize(() => {
    // Vendors table
    db.run(`
        CREATE TABLE IF NOT EXISTS vendors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_name TEXT NOT NULL,
            owner_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            phone TEXT NOT NULL,
            password TEXT NOT NULL,
            logo_url TEXT,
            address TEXT,
            is_open INTEGER DEFAULT 1,
            is_suspended INTEGER DEFAULT 0,
            closed_message TEXT,
            push_subscription TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Menu items table
    db.run(`
        CREATE TABLE IF NOT EXISTS menu_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vendor_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            price DECIMAL(10,2) NOT NULL,
            description TEXT,
            ingredients TEXT,
            photo_url TEXT,
            is_available INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
        )
    `);
    
    // Orders table
    db.run(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vendor_id INTEGER NOT NULL,
            order_number TEXT UNIQUE NOT NULL,
            customer_name TEXT,
            customer_phone TEXT,
            items_json TEXT NOT NULL,
            total DECIMAL(10,2) NOT NULL,
            payment_method TEXT CHECK(payment_method IN ('card', 'cash')) NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
        )
    `);
    
    // Admin users table
    db.run(`
        CREATE TABLE IF NOT EXISTS admin_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'admin',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // ========== NEW TABLES FOR ADS (SQLite version) ==========
    
    // Sponsor ads table
    db.run(`
        CREATE TABLE IF NOT EXISTS sponsor_ads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            link TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Ad settings table
    db.run(`
        CREATE TABLE IF NOT EXISTS ad_settings (
            id INTEGER PRIMARY KEY DEFAULT 1,
            adsense_client TEXT,
            top_slot TEXT,
            middle_slot TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    const bcrypt = require('bcrypt');
    const hashedPassword = bcrypt.hashSync('khezwo123', 10);
    
    db.run(`INSERT OR IGNORE INTO admin_users (username, password, role) 
            VALUES ('khezwo_admin', ?, 'super_admin')`, 
        [hashedPassword]);
    
    console.log('✅ Database tables created (including ad tables)');
});

module.exports = db;