const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function initDatabase() {
    const client = await pool.connect();
    try {
        // Create vendors table
        await client.query(`
            CREATE TABLE IF NOT EXISTS vendors (
                id SERIAL PRIMARY KEY,
                business_name TEXT NOT NULL,
                owner_name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                phone TEXT NOT NULL,
                password TEXT NOT NULL,
                logo_url TEXT,
                background_image TEXT,
                address TEXT,
                is_open INTEGER DEFAULT 1,
                is_suspended INTEGER DEFAULT 0,
                closed_message TEXT,
                push_subscription TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Add column if it doesn't exist (for existing databases)
        await client.query(`
            ALTER TABLE vendors ADD COLUMN IF NOT EXISTS background_image TEXT
        `);
        
        // Create menu_items table
        await client.query(`
            CREATE TABLE IF NOT EXISTS menu_items (
                id SERIAL PRIMARY KEY,
                vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                description TEXT,
                ingredients TEXT,
                photo_url TEXT,
                is_available INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create orders table
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
                order_number TEXT NOT NULL,
                customer_name TEXT,
                customer_phone TEXT,
                items_json TEXT NOT NULL,
                total DECIMAL(10,2) NOT NULL,
                payment_method TEXT CHECK(payment_method IN ('card', 'cash')) NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create admin_users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT DEFAULT 'admin',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create sponsor_ads table
        await client.query(`
            CREATE TABLE IF NOT EXISTS sponsor_ads (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                link TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create ad_settings table
        await client.query(`
            CREATE TABLE IF NOT EXISTS ad_settings (
                id INTEGER PRIMARY KEY DEFAULT 1,
                adsense_client TEXT,
                top_slot TEXT,
                middle_slot TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create default admin user if not exists
        const bcrypt = require('bcrypt');
        const hashedPassword = bcrypt.hashSync('khezwo123', 10);
        
        await client.query(`
            INSERT INTO admin_users (username, password, role) 
            VALUES ('khezwo_admin', $1, 'super_admin')
            ON CONFLICT (username) DO NOTHING
        `, [hashedPassword]);
        
        console.log('✅ Database tables ready');
        console.log('   - background_image column added to vendors');
        
    } catch (err) {
        console.error('Database init error:', err.message);
    } finally {
        client.release();
    }
}

initDatabase();

module.exports = {
    query: (text, params) => pool.query(text, params),
    getClient: () => pool.connect(),
    pool: pool
};