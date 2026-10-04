'use strict';
require('dotenv').config();
var nodemailer = require('nodemailer');

// ============================================
// Parse boolean from env string
// ============================================
function parseBool(val, defaultVal) {
    if (val === undefined || val === null || val === '') return defaultVal;
    return String(val).toLowerCase() === 'true';
}

// ============================================
// SMTP transporter
// ============================================
var emailUser = (process.env.EMAIL_USER || '').trim();
var emailPass = (process.env.EMAIL_PASS || '').trim();
var emailFrom = (process.env.EMAIL_FROM || '').trim() || emailUser;
var emailPort = parseInt(process.env.EMAIL_PORT, 10) || 587;
var emailSecure = parseBool(process.env.EMAIL_SECURE, false);

var transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: emailPort,
    secure: emailSecure,            // true = port 465, false = port 587 (STARTTLS)
    requireTLS: !emailSecure,       // force TLS upgrade on port 587
    auth: {
        user: emailUser,
        pass: emailPass
    },
    tls: {
        rejectUnauthorized: false   // allow self-signed certs (common on shared hosting)
    },
    connectionTimeout: 15000,
    greetingTimeout:   10000,
    socketTimeout:     30000
});

// ============================================
// Verify transporter on startup
// ============================================
transporter.verify(function (err, success) {
    if (err) {
        console.error('[MAIL] SMTP verify failed: ' + err.message);
        console.error('[MAIL] Host: ' + process.env.EMAIL_HOST + ':' + emailPort + ' | User: ' + emailUser);
    } else {
        console.log('[MAIL] SMTP ready — sending as ' + emailFrom);
    }
});

// ============================================
// Send mail
// ============================================
function sendMail(to, subject, html) {
    return transporter.sendMail({
        from: '"Spare Parts System" <' + emailFrom + '>',
        to: to,
        subject: subject,
        html: html
    });
}

module.exports = {
    sendMail: sendMail,
    transporter: transporter
};