const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function updateDatabase() {
    const client = await pool.connect();
    try {
        // Add business_type to vendors
        await client.query(`
            ALTER TABLE vendors ADD COLUMN IF NOT EXISTS business_type TEXT DEFAULT 'restaurant'
        `);
        
        // Add business_size to vendors
        await client.query(`
            ALTER TABLE vendors ADD COLUMN IF NOT EXISTS business_size TEXT DEFAULT 'small'
        `);
        
        // Add subscription_tier to vendors
        await client.query(`
            ALTER TABLE vendors ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'free'
        `);
        
        // Add parent_id for multi-branch support
        await client.query(`
            ALTER TABLE vendors ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES vendors(id)
        `);
        
        // Add is_headquarters flag
        await client.query(`
            ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_headquarters BOOLEAN DEFAULT FALSE
        `);
        
        // Create business_types table
        await client.query(`
            CREATE TABLE IF NOT EXISTS business_types (
                id SERIAL PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                icon TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Insert business types
        await client.query(`
            INSERT INTO business_types (name, icon) VALUES
            ('restaurant', '🍽️'),
            ('clothing', '👕'),
            ('farming', '🌾'),
            ('retail', '🛍️'),
            ('services', '🔧')
            ON CONFLICT (name) DO NOTHING
        `);
        
        // Create subscription_plans table
        await client.query(`
            CREATE TABLE IF NOT EXISTS subscription_plans (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                tier TEXT NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                max_items INTEGER,
                max_branches INTEGER,
                has_analytics BOOLEAN DEFAULT FALSE,
                has_custom_branding BOOLEAN DEFAULT FALSE,
                has_priority_support BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Insert subscription plans
        await client.query(`
            INSERT INTO subscription_plans (name, tier, price, max_items, max_branches, has_analytics, has_custom_branding, has_priority_support) VALUES
            ('Free', 'free', 0, 20, 1, FALSE, FALSE, FALSE),
            ('Pro', 'pro', 299, 999, 1, TRUE, TRUE, FALSE),
            ('Enterprise', 'enterprise', 999, NULL, 10, TRUE, TRUE, TRUE)
            ON CONFLICT (tier) DO NOTHING
        `);
        
        // Create order_tracking table
        await client.query(`
            CREATE TABLE IF NOT EXISTS order_tracking (
                id SERIAL PRIMARY KEY,
                order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                status TEXT DEFAULT 'received',
                estimated_time INTEGER,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create audit_logs table
        await client.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id SERIAL PRIMARY KEY,
                vendor_id INTEGER REFERENCES vendors(id),
                action TEXT NOT NULL,
                details TEXT,
                ip_address TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Add platform_fee to orders
        await client.query(`
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS platform_fee DECIMAL(10,2) DEFAULT 0
        `);
        
        // Add platform_fee_percentage to vendors
        await client.query(`
            ALTER TABLE vendors ADD COLUMN IF NOT EXISTS platform_fee_percentage DECIMAL(5,2) DEFAULT 5
        `);
        
        console.log('✅ Database updated with new features:');
        console.log('   - business_type, business_size, subscription_tier');
        console.log('   - parent_id, is_headquarters (multi-branch)');
        console.log('   - business_types, subscription_plans tables');
        console.log('   - order_tracking, audit_logs tables');
        console.log('   - platform_fee columns');
        
    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        client.release();
        pool.end();
    }
}

updateDatabase();
