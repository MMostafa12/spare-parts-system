'use strict';
var sql = require('mssql');
require('dotenv').config();

// ============================================

// ============================================
var mainConfig = {
    server:   process.env.DB_SERVER,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT, 10) || 1433,
    options: {
        encrypt:                false,
        trustServerCertificate: true,
        enableArithAbort:       true
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// ============================================

// ============================================
var mierpConfig = {
    server:   process.env.MIERP_SERVER,
    database: process.env.MIERP_DB,
    user:     process.env.MIERP_USER,
    password: process.env.MIERP_PASSWORD,
    port:     parseInt(process.env.MIERP_PORT, 10) || 1433,
    options: {
        encrypt:                false,
        trustServerCertificate: true,
        enableArithAbort:       true
    },
    pool: {
        max: 5,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// ============================================
// Connection pools
// ============================================
var poolPromise = new sql.ConnectionPool(mainConfig).connect()
    .then(function(pool) {
        console.log('[DB] Connected to MAIN database: ' + process.env.DB_NAME);
        return pool;
    })
    .catch(function(err) {
        console.error('[DB] MAIN connection failed: ' + err.message);
        throw err;
    });

var poolPromiseMIERP = null;
if (process.env.MIERP_SERVER && process.env.MIERP_DB) {
    poolPromiseMIERP = new sql.ConnectionPool(mierpConfig).connect()
        .then(function(pool) {
            console.log('[DB] Connected to MIERP2 database: ' + process.env.MIERP_DB);
            return pool;
        })
        .catch(function(err) {
            console.error('[DB] MIERP2 connection failed: ' + err.message);
            return null;
        });
} else {
    console.log('[DB] MIERP2 not configured — skipping connection.');
}

module.exports = {
    sql:              sql,
    poolPromise:      poolPromise,
    poolPromiseMIERP: poolPromiseMIERP
};