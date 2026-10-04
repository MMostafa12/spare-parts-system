'use strict';
require('dotenv').config();
var express = require('express');
var session = require('express-session');
var path = require('path');
var app = express();

app.use(function(req, res, next) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// FIXED: Point to 'locals' folder (without an 'e')
app.use('/locales', express.static(path.join(__dirname, 'public/locals')));
app.use('/locals', express.static(path.join(__dirname, 'public/locals')));

app.use('/js', express.static(path.join(__dirname, 'public/js')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'somethingsecrethere123',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
    rolling: true
}));

console.log('📦 Loading routes...');

var authRoutes     = require('./routes/auth');
var requestRoutes  = require('./routes/requests');
var approvalRoutes = require('./routes/approvals');
var managerRoutes  = require('./routes/manager');
var alexRoutes     = require('./routes/alex');

console.log('  auth:      ' + typeof authRoutes);
console.log('  requests:  ' + typeof requestRoutes);
console.log('  approvals: ' + typeof approvalRoutes);
console.log('  manager:   ' + typeof managerRoutes);
console.log('  alex:      ' + typeof alexRoutes);

function registerRoute(p, r) {
    if (typeof r !== 'function') {
        console.error('❌ BROKEN ROUTER at ' + p + ' — got ' + typeof r);
        process.exit(1);
    }
    app.use(p, r);
    console.log('  ✅ mounted: ' + p);
}

registerRoute('/', authRoutes);
registerRoute('/requests', requestRoutes);
registerRoute('/approvals', approvalRoutes);
registerRoute('/manager', managerRoutes);
registerRoute('/alex', alexRoutes);

app.use(function(err, req, res, next) {
    console.error('❌ Server Error:', err.message);
    if (res.headersSent) return next(err);
    res.status(500).send('System Error: ' + err.message);
});

app.use(function(req, res) {
    res.status(404).send('<h2>404 - Not Found</h2><a href="/">Go Home</a>');
});

var port = process.env.APP_PORT || ;
app.listen(port, '0.0.0.0', function() {
    console.log('=================================');
    console.log('🚀 Server running on port ' + port);
    console.log('🌐 http://localhost:' + port);
    console.log('=================================');
});