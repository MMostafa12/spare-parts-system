'use strict';
var express = require('express');
var router = express.Router();
var db = require('../config/db');
var sql = db.sql;
var poolPromise = db.poolPromise;
var { sendMail } = require('../config/mail');
var emailTemplates = require('../config/emailTemplates');

function validSignature(sig) {
    if (!sig || sig.trim() === '') return false;
    return /^[a-zA-Z\u0600-\u06FF\s]+$/.test(sig.trim());
}

// ========== GET ALL REQUESTS ==========
router.get('/all', function(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    var userRole = req.session.user.role;
    console.log('📋 User role:', userRole);

    poolPromise.then(function(pool) {
        return pool.request().query('SELECT * FROM Requests ORDER BY created_at DESC');
    }).then(function(result) {
        var allRequests = result.recordset;
        console.log('📊 Total requests in DB:', allRequests.length);

        var filteredRequests = [];

        if (userRole === 'service') {
            filteredRequests = allRequests;
        } else if (userRole === 'finance') {
            filteredRequests = allRequests.filter(function(req) {
                return ['Pending Finance', 'Pending Warehouse'].indexOf(req.status) !== -1;
            });
        } else if (userRole === 'warehouse') {
            filteredRequests = allRequests.filter(function(req) {
                return ['Pending Warehouse', 'Fulfilled'].indexOf(req.status) !== -1;
            });
        } else if (userRole === 'manager') {
            filteredRequests = allRequests;
        } else {
            filteredRequests = allRequests;
        }

        console.log('✅ Found', filteredRequests.length, 'requests for', userRole);
        res.json(filteredRequests);
    }).catch(function(err) {
        console.error('❌ Database error:', err.message);
        res.status(500).json({ error: 'Database error: ' + err.message });
    });
});

// ========== GET SINGLE REQUEST DETAILS ==========
router.get('/details/:id', function(req, res) {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    var pool;
    var requestData;
    poolPromise.then(function(p) {
        pool = p;
        return pool.request().input('id', sql.Int, req.params.id).query('SELECT * FROM Requests WHERE id = @id');
    }).then(function(r) {
        if (!r.recordset[0]) return res.status(404).json({ error: 'Not found' });
        requestData = r.recordset[0];
        return pool.request().input('id', sql.Int, req.params.id).query('SELECT * FROM RequestItems WHERE request_id = @id ORDER BY line_number');
    }).then(function(items) {
        res.json({ request: requestData, items: items.recordset });
    }).catch(function(err) {
        console.error('❌ Details error:', err);
        res.status(500).json({ error: err.message });
    });
});

// ========== PRINT REQUEST ==========
router.get('/print/:id', function(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    var requestId = parseInt(req.params.id);
    if (isNaN(requestId)) {
        return res.status(400).json({ error: 'Invalid request ID' });
    }

    var pool;
    var requestData;

    poolPromise.then(function(p) {
        pool = p;
        return pool.request()
            .input('id', sql.Int, requestId)
            .query('SELECT * FROM Requests WHERE id = @id');
    }).then(function(r) {
        if (!r.recordset[0]) {
            return res.status(404).json({ error: 'Not found' });
        }
        requestData = r.recordset[0];

        return pool.request()
            .input('id', sql.Int, requestId)
            .query('SELECT * FROM RequestItems WHERE request_id = @id ORDER BY line_number');
    }).then(function(items) {
        if (res.headersSent) return;
        res.json({
            request: requestData,
            items: items && items.recordset ? items.recordset : []
        });
    }).catch(function(err) {
        console.error('❌ /approvals/print/:id error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    });
});

// ========== HELPER FUNCTIONS ==========
function getUsersByRole(pool, roles) {
    var roleList = roles.map(function(r) { return "'" + r + "'"; }).join(', ');
    return pool.request()
        .query("SELECT name, email FROM Users WHERE role IN (" + roleList + ") AND email IS NOT NULL AND email != ''");
}

function getRequesterEmail(pool, requesterId) {
    return pool.request()
        .input('id', sql.Int, requesterId)
        .query('SELECT name, email FROM Users WHERE id = @id');
}

// ============================================
// Send notes notification to previous steps
// service   → requester + manager
// finance   → requester + service + manager
// warehouse → requester + service + finance + manager
// (Alex)    → + dept manager in all cases
// ============================================
function sendNotesNotification(pool, requestId, notesBy) {
    emailTemplates.loadRequestWithItems(pool, requestId)
        .then(function (data) {
            if (!data.req) return;
            var req = data.req;

            var notesText = '';
            if (notesBy === 'service')   notesText = req.service_approval_notes   || '';
            if (notesBy === 'finance')   notesText = req.finance_approval_notes   || '';
            if (notesBy === 'warehouse') notesText = req.warehouse_approval_notes || '';

            if (!notesText || notesText.trim() === '') return;

            var isAlex = (req.branch === 'Alex');
            var emails = [];
            var recipientPromises = [];

            var notifyService = (notesBy === 'finance' || notesBy === 'warehouse');
            var notifyFinance = (notesBy === 'warehouse');

            // Requester always
            recipientPromises.push(
                getRequesterEmail(pool, req.requester_id).then(function (r) {
                    if (r.recordset[0] && r.recordset[0].email) {
                        emails.push(r.recordset[0].email);
                    }
                })
            );

            // Manager always
            recipientPromises.push(
                getUsersByRole(pool, ['manager']).then(function (r) {
                    r.recordset.forEach(function (u) {
                        if (u.email && u.email.trim() !== '') emails.push(u.email);
                    });
                })
            );

            if (notifyService) {
                recipientPromises.push(
                    getUsersByRole(pool, ['service']).then(function (r) {
                        r.recordset.forEach(function (u) {
                            if (u.email && u.email.trim() !== '') emails.push(u.email);
                        });
                    })
                );
            }

            if (notifyFinance) {
                recipientPromises.push(
                    getUsersByRole(pool, ['finance']).then(function (r) {
                        r.recordset.forEach(function (u) {
                            if (u.email && u.email.trim() !== '') emails.push(u.email);
                        });
                    })
                );
            }

            if (isAlex && req.department_name) {
                recipientPromises.push(
                    pool.request()
                        .input('department', sql.NVarChar, req.department_name)
                        .query("SELECT email FROM Users WHERE role IN ('ctmanager','mrimanager','xraymanager','angiomanager','konicamanager','salesmanager','usmanager','projectsmanager') AND department = @department AND email IS NOT NULL AND email != ''")
                        .then(function (r) {
                            r.recordset.forEach(function (u) {
                                if (u.email && u.email.trim() !== '') emails.push(u.email);
                            });
                        })
                );
            }

            return Promise.all(recipientPromises).then(function () {
                var unique = emails.filter(function (e, i) { return emails.indexOf(e) === i; });
                if (unique.length === 0) {
                    console.log('⚠️ No recipients for notes notification on request #' + requestId);
                    return;
                }

                var label = notesBy.charAt(0).toUpperCase() + notesBy.slice(1);
                var subject = '📝 ' + label + ' added a note on Request #' + requestId + ' — ' + (req.customer_name || req.organization_name || '');

                var html = emailTemplates.buildNotesNotificationEmail({
                    req: req,
                    items: data.items,
                    notesBy: notesBy,
                    notesText: notesText
                });

                sendMail(unique.join(', '), subject, html)
                    .then(function () {
                        console.log('✅ Notes notification (' + notesBy + ') for request #' + requestId + ' → ' + unique.length + ' recipients');
                    })
                    .catch(function (err) {
                        console.error('❌ Failed to send notes notification:', err.message);
                    });
            });
        })
        .catch(function (err) {
            console.error('❌ Error in sendNotesNotification:', err);
        });
}

// ========== SEND SEQUENTIAL EMAIL ==========
function sendSequentialEmail(pool, requestId, action, role, signature, reason, comment, isFulfilled) {
    var step = '';
    var recipients = [];
    var title = '';
    var statusColor = '';
    var statusText = '';
    var actionText = '';
    var roleText = '';

    if (action === 'new') {
        step = 'new';
        recipients = ['service', 'manager'];
        title = '📋 New Spare Parts Request';
        statusColor = '#1a3a5c';
        statusText = 'Pending Service Approval';
        actionText = '✅ New Request Submitted';
        roleText = 'System';
    } else if (action === 'approve' && role === 'service') {
        step = 'service_approve';
        recipients = ['finance', 'manager'];
        title = '📋 Service Approved - Waiting for Finance';
        statusColor = '#1e6b3c';
        statusText = 'Pending Finance Approval';
        actionText = '✅ Service Approved - Next: Finance';
        roleText = 'Service Department';
    } else if (action === 'reject' && role === 'service') {
        step = 'service_reject';
        recipients = ['requester', 'manager'];
        title = '❌ Request Rejected by Service';
        statusColor = '#8b1a1a';
        statusText = 'Rejected by Service';
        actionText = '❌ Service Rejected Request';
        roleText = 'Service Department';
    } else if (action === 'approve' && role === 'finance') {
        step = 'finance_approve';
        recipients = ['warehouse', 'manager'];
        title = '📋 Finance Approved - Waiting for Warehouse';
        statusColor = '#1e6b3c';
        statusText = 'Pending Warehouse Fulfillment';
        actionText = '✅ Finance Approved - Next: Warehouse';
        roleText = 'Finance Department';
    } else if (action === 'reject' && role === 'finance') {
        step = 'finance_reject';
        recipients = ['requester', 'manager'];
        title = '❌ Request Rejected by Finance';
        statusColor = '#8b1a1a';
        statusText = 'Rejected by Finance';
        actionText = '❌ Finance Rejected Request';
        roleText = 'Finance Department';
    } else if (action === 'fulfill' && role === 'warehouse') {
        step = 'warehouse_fulfill';
        recipients = ['requester', 'manager'];
        title = '✅ Request Ready for Pickup - Warehouse';
        statusColor = '#1e6b3c';
        statusText = 'Fulfilled - Ready for Pickup 🎉';
        actionText = '✅ Request Fulfilled - Ready to Collect';
        roleText = 'Warehouse Department';
    } else if (action === 'reject' && role === 'warehouse') {
        step = 'warehouse_reject';
        recipients = ['requester', 'manager'];
        title = '❌ Request Rejected by Warehouse';
        statusColor = '#8b1a1a';
        statusText = 'Rejected by Warehouse';
        actionText = '❌ Warehouse Rejected Request';
        roleText = 'Warehouse Department';
    } else if (action === 'override_service') {
        step = 'override_service';
        recipients = ['finance', 'manager'];
        title = '📋 Manager Override - Service';
        statusColor = '#6c3483';
        statusText = 'Pending Finance (Manager Override)';
        actionText = '✅ Manager Override (Service)';
        roleText = 'Manager';
    } else if (action === 'override_finance') {
        step = 'override_finance';
        recipients = ['warehouse', 'manager'];
        title = '📋 Manager Override - Finance';
        statusColor = '#6c3483';
        statusText = 'Pending Warehouse (Manager Override)';
        actionText = '✅ Manager Override (Finance)';
        roleText = 'Manager';
    }

    emailTemplates.loadRequestWithItems(pool, requestId)
        .then(function (data) {
            var req = data.req;
            if (!req) return;
            var items = data.items || [];

            var recipientEmails = [];
            var recipientPromises = [];

            if (recipients.indexOf('requester') !== -1) {
                recipientPromises.push(
                    getRequesterEmail(pool, req.requester_id)
                        .then(function (r) {
                            if (r.recordset[0] && r.recordset[0].email) {
                                recipientEmails.push(r.recordset[0].email);
                            }
                        })
                );
            }

            var roleRecipients = recipients.filter(function (r) { return r !== 'requester'; });
            if (roleRecipients.length > 0) {
                recipientPromises.push(
                    getUsersByRole(pool, roleRecipients)
                        .then(function (r) {
                            r.recordset.forEach(function (user) {
                                if (user.email && user.email.trim() !== '') {
                                    recipientEmails.push(user.email);
                                }
                            });
                        })
                );
            }

            return Promise.all(recipientPromises)
                .then(function () {
                    var uniqueEmails = recipientEmails.filter(function (email, index) {
                        return recipientEmails.indexOf(email) === index;
                    });

                    if (uniqueEmails.length === 0) {
                        console.log('⚠️ No recipients found for step:', step);
                        return;
                    }

                    console.log('📧 Step:', step, '- Sending to:', uniqueEmails);

                    var subject = '';
                    switch (step) {
                        case 'new':
                            subject = '📋 New Request #' + requestId + ' - Pending Service Approval';
                            break;
                        case 'service_approve':
                            subject = '📋 Request #' + requestId + ' - Service Approved, Waiting for Finance';
                            break;
                        case 'service_reject':
                            subject = '❌ Request #' + requestId + ' - Rejected by Service';
                            break;
                        case 'finance_approve':
                            subject = '📋 Request #' + requestId + ' - Finance Approved, Waiting for Warehouse';
                            break;
                        case 'finance_reject':
                            subject = '❌ Request #' + requestId + ' - Rejected by Finance';
                            break;
                        case 'warehouse_fulfill':
                            subject = '✅ Request #' + requestId + ' - Ready for Pickup at Warehouse 🎉';
                            break;
                        case 'warehouse_reject':
                            subject = '❌ Request #' + requestId + ' - Rejected by Warehouse';
                            break;
                        case 'override_service':
                            subject = '📋 Request #' + requestId + ' - Manager Override (Service)';
                            break;
                        case 'override_finance':
                            subject = '📋 Request #' + requestId + ' - Manager Override (Finance)';
                            break;
                        default:
                            subject = '📋 Request #' + requestId + ' - Status Update';
                    }

                    var emailHtml = emailTemplates.buildRequestEmail({
                        req: req,
                        items: items,
                        title: title,
                        statusColor: statusColor,
                        statusText: statusText,
                        actionText: actionText,
                        roleText: roleText,
                        signature: signature,
                        reason: reason,
                        comment: comment,
                        isFulfilled: !!isFulfilled
                    });

                    sendMail(uniqueEmails.join(', '), subject, emailHtml)
                        .then(function () {
                            console.log('✅ Email sent for step:', step, 'to:', uniqueEmails.length, 'recipients');
                        })
                        .catch(function (err) {
                            console.error('❌ Failed to send email for step:', step, err.message);
                        });
                });
        })
        .catch(function (err) {
            console.error('❌ Error sending sequential email:', err);
        });
}

// ========== SERVICE APPROVAL ==========
router.post('/service/:id', function(req, res) {
    if (!req.session.user || req.session.user.role !== 'service') return res.status(403).json({ error: 'Unauthorized' });
    var action = req.body.action;
    var service_signature = req.body.service_signature || '';
    var rejection_reason = req.body.rejection_reason || '';
    var reject_signature = req.body.reject_signature || '';
    var requestId = req.params.id;
    var pool;

    if (action === 'reject') {
        if (!rejection_reason.trim()) return res.status(400).json({ error: 'Rejection reason required.' });
        if (!validSignature(reject_signature)) return res.status(400).json({ error: 'Signature required for rejection.' });
        poolPromise.then(function(p) {
            pool = p;
            return pool.request()
                .input('id', sql.Int, requestId)
                .input('rejection_reason', sql.NVarChar, rejection_reason.trim())
                .input('reject_sig', sql.NVarChar, reject_signature.trim())
                .query("UPDATE Requests SET status='Rejected by Service', service_rejection_reason=@rejection_reason, service_rejection_signature=@reject_sig, service_rejection_date=GETDATE() WHERE id=@id");
        }).then(function() {
            sendSequentialEmail(pool, requestId, 'reject', 'service', reject_signature, rejection_reason, '', false);
            res.json({ success: true });
        }).catch(function(err) {
            res.status(500).json({ error: err.message });
        });
        return;
    }

    if (!validSignature(service_signature)) return res.status(400).json({ error: 'Invalid signature.' });

    var service_notes = (req.body.service_notes || '').trim();

    poolPromise.then(function(p) {
        pool = p;
        return pool.request()
            .input('id', sql.Int, requestId)
            .input('service_signature', sql.NVarChar, service_signature.trim())
            .input('service_notes', sql.NVarChar(500), service_notes || null)
            .query("UPDATE Requests SET status='Pending Finance', service_signature=@service_signature, service_signature_date=GETDATE(), service_approved_at=GETDATE(), service_approval_notes=@service_notes WHERE id=@id");
    }).then(function() {
        sendSequentialEmail(pool, requestId, 'approve', 'service', service_signature, '', service_notes, false);
        if (service_notes && service_notes.trim() !== '') {
            sendNotesNotification(pool, requestId, 'service');
        }
        res.json({ success: true });
    }).catch(function(err) {
        res.status(500).json({ error: err.message });
    });
});

// ========== FINANCE APPROVAL ==========
router.post('/finance/:id', function(req, res) {
    if (!req.session.user || req.session.user.role !== 'finance') return res.status(403).json({ error: 'Unauthorized' });
    var action = req.body.action;
    var finance_signature = req.body.finance_signature || '';
    var rejection_reason = req.body.rejection_reason || '';
    var reject_signature = req.body.reject_signature || '';
    var requestId = req.params.id;
    var pool;

    if (action === 'reject') {
        if (!rejection_reason.trim()) return res.status(400).json({ error: 'Rejection reason required.' });
        if (!validSignature(reject_signature)) return res.status(400).json({ error: 'Signature required for rejection.' });
        poolPromise.then(function(p) {
            pool = p;
            return pool.request()
                .input('id', sql.Int, requestId)
                .input('rejection_reason', sql.NVarChar, rejection_reason.trim())
                .input('reject_sig', sql.NVarChar, reject_signature.trim())
                .query("UPDATE Requests SET status='Rejected by Finance', finance_rejection_reason=@rejection_reason, finance_rejection_signature=@reject_sig, finance_rejection_date=GETDATE() WHERE id=@id");
        }).then(function() {
            sendSequentialEmail(pool, requestId, 'reject', 'finance', reject_signature, rejection_reason, '', false);
            res.json({ success: true });
        }).catch(function(err) {
            res.status(500).json({ error: err.message });
        });
        return;
    }

    if (!validSignature(finance_signature)) return res.status(400).json({ error: 'Invalid signature.' });

    var finance_notes = (req.body.finance_notes || '').trim();

    poolPromise.then(function(p) {
        pool = p;
        return pool.request()
            .input('id', sql.Int, requestId)
            .input('finance_signature', sql.NVarChar, finance_signature.trim())
            .input('finance_notes', sql.NVarChar(500), finance_notes || null)
            .query("UPDATE Requests SET status='Pending Warehouse', finance_signature=@finance_signature, finance_signature_date=GETDATE(), finance_approved_at=GETDATE(), finance_approval_notes=@finance_notes WHERE id=@id");
    }).then(function() {
        sendSequentialEmail(pool, requestId, 'approve', 'finance', finance_signature, '', '', false);
        if (finance_notes && finance_notes.trim() !== '') {
            sendNotesNotification(pool, requestId, 'finance');
        }
        res.json({ success: true });
    }).catch(function(err) {
        res.status(500).json({ error: err.message });
    });
});

// ========== WAREHOUSE FULFILLMENT ==========
router.post('/warehouse/:id', function(req, res) {
    try {
        if (!req.session.user || req.session.user.role !== 'warehouse') {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        var action = req.body.action;
        var rejection_reason = req.body.rejection_reason || '';
        var reject_signature = req.body.reject_signature || '';
        var dispatch_date = req.body.dispatch_date || null;
        var dispatch_permit_number = req.body.dispatch_permit_number || null;
        var receiving_engineer = req.body.receiving_engineer || null;
        var warehouse_signature = req.body.warehouse_signature || null;
        var defective_return_date = req.body.defective_return_date || null;
        var requestId = req.params.id;
        var pool;

        console.log('📋 Warehouse fulfill request #' + requestId);
        console.log('📋 Warehouse signature:', warehouse_signature);

        if (action === 'reject') {
            if (!rejection_reason.trim()) {
                return res.status(400).json({ error: 'Rejection reason required.' });
            }
            if (!validSignature(reject_signature)) {
                return res.status(400).json({ error: 'Signature required for rejection.' });
            }
            poolPromise.then(function(p) {
                pool = p;
                return pool.request()
                    .input('id', sql.Int, requestId)
                    .input('rejection_reason', sql.NVarChar, rejection_reason.trim())
                    .input('reject_sig', sql.NVarChar, reject_signature.trim())
                    .query("UPDATE Requests SET status='Rejected by Warehouse', warehouse_rejection_reason=@rejection_reason, warehouse_rejection_signature=@reject_sig, warehouse_rejection_date=GETDATE() WHERE id=@id");
            }).then(function() {
                sendSequentialEmail(pool, requestId, 'reject', 'warehouse', reject_signature, rejection_reason, '', false);
                res.json({ success: true });
            }).catch(function(err) {
                console.error('❌ Reject error:', err);
                res.status(500).json({ error: err.message });
            });
            return;
        }

        if (!warehouse_signature || warehouse_signature.trim() === '') {
            return res.status(400).json({ error: 'Warehouse signature is required.' });
        }

        if (!validSignature(warehouse_signature)) {
            return res.status(400).json({ error: 'Invalid warehouse signature.' });
        }

        var warehouse_notes = (req.body.warehouse_notes || '').trim();

        poolPromise.then(function(p) {
            pool = p;
            return pool.request()
                .input('id', sql.Int, req.params.id)
                .query('SELECT requester_signature, service_signature, finance_signature, manager_approved_service_signature, manager_approved_finance_signature FROM Requests WHERE id=@id');
        }).then(function(result) {
            var r = result.recordset[0];
            if (!r) {
                return res.status(404).json({ error: 'Request not found.' });
            }

            var hasRequesterSig = r.requester_signature && r.requester_signature.trim() !== '';
            var hasServiceSig = (r.service_signature && r.service_signature.trim() !== '') ||
                               (r.manager_approved_service_signature && r.manager_approved_service_signature.trim() !== '');
            var hasFinanceSig = (r.finance_signature && r.finance_signature.trim() !== '') ||
                               (r.manager_approved_finance_signature && r.manager_approved_finance_signature.trim() !== '');

            console.log('📋 Signature check for request #' + requestId);
            console.log('  Requester: ' + (hasRequesterSig ? '✅' : '❌'));
            console.log('  Service: ' + (hasServiceSig ? '✅' : '❌'));
            console.log('  Finance: ' + (hasFinanceSig ? '✅' : '❌'));
            console.log('  Warehouse: ' + (warehouse_signature ? '✅' : '❌'));

            if (!hasRequesterSig || !hasServiceSig || !hasFinanceSig) {
                var missing = [];
                if (!hasRequesterSig) missing.push('Requester');
                if (!hasServiceSig) missing.push('Service');
                if (!hasFinanceSig) missing.push('Finance');
                return res.status(400).json({
                    error: 'Cannot fulfill — missing signatures: ' + missing.join(', ')
                });
            }

            return pool.request()
                .input('id', sql.Int, req.params.id)
                .input('dispatch_date', sql.Date, dispatch_date)
                .input('dispatch_permit_number', sql.NVarChar, dispatch_permit_number)
                .input('receiving_engineer', sql.NVarChar, receiving_engineer)
                .input('warehouse_signature', sql.NVarChar, warehouse_signature)
                .input('defective_return_date', sql.Date, defective_return_date)
                .input('warehouse_notes', sql.NVarChar(500), warehouse_notes || null)
                .query(`
                    UPDATE Requests SET
                        status = 'Fulfilled',
                        fulfilled_at = GETDATE(),
                        warehouse_signature = @warehouse_signature,
                        warehouse_signature_date = GETDATE(),
                        dispatch_date = @dispatch_date,
                        dispatch_permit_number = @dispatch_permit_number,
                        receiving_engineer = @receiving_engineer,
                        defective_return_date = @defective_return_date,
                        warehouse_approval_notes = @warehouse_notes
                    WHERE id = @id
                `);
        }).then(function() {
            var updatePromises = [];
            var body = req.body;

            Object.keys(body).forEach(function(key) {
                if (key.startsWith('addition_permit_')) {
                    var lineNumber = parseInt(key.replace('addition_permit_', ''));
                    var permitValue = body[key];

                    if (!isNaN(lineNumber) && permitValue !== undefined && permitValue !== null) {
                        updatePromises.push(
                            pool.request()
                                .input('request_id', sql.Int, requestId)
                                .input('line_number', sql.Int, lineNumber)
                                .input('addition_permit', sql.NVarChar, permitValue)
                                .query("UPDATE RequestItems SET addition_permit = @addition_permit WHERE request_id = @request_id AND line_number = @line_number")
                        );
                    }
                }
            });

            return Promise.all(updatePromises);
        }).then(function() {
            console.log('✅ Request #' + requestId + ' fulfilled successfully');
            sendSequentialEmail(pool, requestId, 'fulfill', 'warehouse', warehouse_signature || 'System', '', '', true);
            if (warehouse_notes && warehouse_notes.trim() !== '') {
                sendNotesNotification(pool, requestId, 'warehouse');
            }
            res.json({ success: true, message: 'Request fulfilled successfully!' });
        }).catch(function(err) {
            console.error('❌ Warehouse error:', err);
            res.status(500).json({ error: err.message });
        });
    } catch (err) {
        console.error('❌ Warehouse catch error:', err);
        res.status(500).json({ error: 'An unexpected error occurred: ' + err.message });
    }
});

// ========== SAVE ADDITION PERMIT ONLY ==========
router.post('/save-addition-permit/:id', function(req, res) {
    console.log('========================================');
    console.log('🔵 SAVE ADDITION PERMIT ROUTE CALLED');
    console.log('🔵 Request ID:', req.params.id);
    console.log('🔵 Request Body:', req.body);
    console.log('🔵 Session User:', req.session.user);
    console.log('========================================');

    try {
        if (!req.session.user) {
            console.log('❌ No session user');
            return res.status(401).json({ error: 'Not logged in' });
        }

        if (req.session.user.role !== 'warehouse') {
            console.log('❌ Not warehouse user, role:', req.session.user.role);
            return res.status(403).json({ error: 'Unauthorized - Warehouse access required' });
        }

        var requestId = parseInt(req.params.id);
        if (isNaN(requestId)) {
            console.log('❌ Invalid request ID:', req.params.id);
            return res.status(400).json({ error: 'Invalid request ID' });
        }

        var body = req.body;
        console.log('📋 Body keys:', Object.keys(body));

        var hasValues = false;
        Object.keys(body).forEach(function(key) {
            if (key.startsWith('addition_permit_')) {
                hasValues = true;
                console.log('📝 Found:', key, '=', body[key]);
            }
        });

        if (!hasValues) {
            console.log('❌ No addition permit values found');
            return res.status(400).json({ error: 'No addition permit values to save.' });
        }

        var pool;
        poolPromise.then(function(p) {
            console.log('✅ Database connected');
            pool = p;
            return pool.request()
                .input('id', sql.Int, requestId)
                .query('SELECT id FROM Requests WHERE id = @id');
        }).then(function(result) {
            console.log('📋 Request exists check:', result.recordset);
            if (!result.recordset || result.recordset.length === 0) {
                console.log('❌ Request not found');
                return res.status(404).json({ error: 'Request not found.' });
            }

            var updatePromises = [];

            Object.keys(body).forEach(function(key) {
                if (key.startsWith('addition_permit_')) {
                    var lineNumber = parseInt(key.replace('addition_permit_', ''));
                    var permitValue = body[key];

                    if (!isNaN(lineNumber) && permitValue !== undefined && permitValue !== null) {
                        console.log('📝 Updating line ' + lineNumber + ' with: ' + permitValue);
                        updatePromises.push(
                            pool.request()
                                .input('request_id', sql.Int, requestId)
                                .input('line_number', sql.Int, lineNumber)
                                .input('addition_permit', sql.NVarChar, permitValue)
                                .query("UPDATE RequestItems SET addition_permit = @addition_permit WHERE request_id = @request_id AND line_number = @line_number")
                        );
                    }
                }
            });

            return Promise.all(updatePromises);
        }).then(function() {
            console.log('✅ Addition permits saved successfully for request #' + requestId);
            return res.json({ success: true, message: 'Addition permits saved successfully!' });
        }).catch(function(err) {
            console.error('❌ Database error:', err);
            console.error('❌ Error stack:', err.stack);
            return res.status(500).json({ error: 'Database error: ' + err.message });
        });

    } catch (err) {
        console.error('❌ Catch error:', err);
        console.error('❌ Error stack:', err.stack);
        return res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ========== CANCEL FULFILLMENT ==========
router.post('/cancel-fulfillment/:id', function(req, res) {
    if (!req.session.user || req.session.user.role !== 'warehouse') {
        return res.status(403).json({ error: 'Unauthorized - Warehouse access required' });
    }

    var requestId = req.params.id;
    var reason = req.body.reason || 'No reason provided';
    var signature = req.body.signature || '';
    var pool;

    if (!signature || signature.trim() === '') {
        return res.status(400).json({ error: 'Signature is required.' });
    }
    if (!/^[a-zA-Z\u0600-\u06FF\s]+$/.test(signature.trim())) {
        return res.status(400).json({ error: 'Signature must contain only letters and spaces.' });
    }

    poolPromise.then(function(p) {
        pool = p;
        return pool.request()
            .input('id', sql.Int, requestId)
            .query('SELECT id, status, requester_id FROM Requests WHERE id = @id');
    }).then(function(result) {
        if (!result.recordset || result.recordset.length === 0) {
            return res.status(404).json({ error: 'Request not found.' });
        }

        var req = result.recordset[0];
        if (req.status !== 'Fulfilled') {
            return res.status(400).json({ error: 'Only fulfilled requests can be cancelled.' });
        }

        return pool.request()
            .input('id', sql.Int, requestId)
            .input('reason', sql.NVarChar, reason)
            .input('signature', sql.NVarChar, signature.trim())
            .query(`
                UPDATE Requests SET
                    status = 'Rejected by Warehouse',
                    service_signature = NULL,
                    service_signature_date = NULL,
                    service_approved_at = NULL,
                    service_rejection_reason = NULL,
                    service_rejection_signature = NULL,
                    service_rejection_date = NULL,
                    finance_signature = NULL,
                    finance_signature_date = NULL,
                    finance_approved_at = NULL,
                    finance_rejection_reason = NULL,
                    finance_rejection_signature = NULL,
                    finance_rejection_date = NULL,
                    warehouse_rejection_reason = @reason,
                    warehouse_rejection_signature = @signature,
                    warehouse_rejection_date = GETDATE(),
                    dispatch_date = NULL,
                    dispatch_permit_number = NULL,
                    receiving_engineer = NULL,
                    warehouse_signature = NULL,
                    warehouse_signature_date = NULL,
                    defective_return_date = NULL,
                    fulfilled_at = NULL,
                    manager_approved_service_signature = NULL,
                    manager_approved_service_date = NULL,
                    manager_approved_service_comment = NULL,
                    manager_approved_finance_signature = NULL,
                    manager_approved_finance_date = NULL,
                    manager_approved_finance_comment = NULL
                WHERE id = @id
            `);
    }).then(function() {
        return pool.request()
            .input('id', sql.Int, requestId)
            .query('SELECT requester_id FROM Requests WHERE id = @id');
    }).then(function(result) {
        if (result.recordset && result.recordset.length > 0) {
            var requesterId = result.recordset[0].requester_id;
            return pool.request()
                .input('id', sql.Int, requesterId)
                .query('SELECT name, email FROM Users WHERE id = @id');
        }
        return null;
    }).then(function(userResult) {
        if (userResult && userResult.recordset && userResult.recordset.length > 0) {
            var requesterEmail = userResult.recordset[0].email;

            return emailTemplates.loadRequestWithItems(pool, requestId)
                .then(function (data) {
                    if (!data.req) {
                        res.json({ success: true, message: 'Fulfillment cancelled. Request returned to requester for editing.' });
                        return;
                    }

                    var subject = '❌ Fulfillment Cancelled - Request #' + requestId;
                    var html = emailTemplates.buildRequestEmail({
                        req: data.req,
                        items: data.items,
                        title: '❌ Fulfillment Cancelled',
                        statusColor: '#8b1a1a',
                        statusText: 'Rejected by Warehouse',
                        actionText: '⚠️ Warehouse has cancelled the fulfillment',
                        roleText: 'Warehouse Department',
                        signature: signature,
                        reason: reason
                    });

                    sendMail(requesterEmail, subject, html)
                        .then(function () {
                            console.log('✅ Cancellation email sent to requester:', requesterEmail);
                        })
                        .catch(function (err) {
                            console.error('❌ Failed to send cancellation email:', err.message);
                        });

                    res.json({ success: true, message: 'Fulfillment cancelled. Request returned to requester for editing.' });
                });
        }

        res.json({ success: true, message: 'Fulfillment cancelled. Request returned to requester for editing.' });
    }).catch(function(err) {
        console.error('Cancel fulfillment error:', err);
        res.status(500).json({ error: 'An error occurred while cancelling fulfillment.' });
    });
});

// ========== MANAGER OVERRIDE - SERVICE ==========
router.post('/manager-override-service/:id', function(req, res) {
    if (!req.session.user || req.session.user.role !== 'manager') return res.status(403).json({ error: 'Unauthorized' });
    var signature = req.body.signature || '';
    var comment = req.body.comment || '';
    var requestId = req.params.id;
    var pool;

    if (!validSignature(signature)) return res.status(400).json({ error: 'Invalid signature.' });
    if (!comment.trim()) return res.status(400).json({ error: 'Comment is required.' });

    poolPromise.then(function(p) {
        pool = p;
        return pool.request().input('id', sql.Int, requestId)
            .query('SELECT status, finance_signature FROM Requests WHERE id=@id');
    }).then(function(r) {
        var row = r.recordset[0];
        if (!row) return res.status(404).json({ error: 'Request not found.' });
        if (row.status !== 'Pending Service') {
            return res.status(400).json({ error: 'Can only override Service while status is Pending Service.' });
        }
        var financeAlreadyDone = row.finance_signature && row.finance_signature.trim() !== '';
        var newStatus = financeAlreadyDone ? 'Pending Warehouse' : 'Pending Finance';

        return pool.request()
            .input('id', sql.Int, requestId)
            .input('sig', sql.NVarChar, signature.trim())
            .input('comment', sql.NVarChar, comment.trim())
            .input('status', sql.NVarChar, newStatus)
            .query("UPDATE Requests SET status=@status, manager_approved_service_signature=@sig, manager_approved_service_date=GETDATE(), manager_approved_service_comment=@comment WHERE id=@id");
    }).then(function() {
        sendSequentialEmail(pool, requestId, 'override_service', 'manager', signature, '', comment, false);
        res.json({ success: true });
    }).catch(function(err) {
        res.status(500).json({ error: err.message });
    });
});

// ========== MANAGER OVERRIDE - FINANCE ==========
router.post('/manager-override-finance/:id', function(req, res) {
    if (!req.session.user || req.session.user.role !== 'manager') return res.status(403).json({ error: 'Unauthorized' });
    var signature = req.body.signature || '';
    var comment = req.body.comment || '';
    var requestId = req.params.id;
    var pool;

    if (!validSignature(signature)) return res.status(400).json({ error: 'Invalid signature.' });
    if (!comment.trim()) return res.status(400).json({ error: 'Comment is required.' });

    poolPromise.then(function(p) {
        pool = p;
        return pool.request().input('id', sql.Int, requestId)
            .query('SELECT status FROM Requests WHERE id=@id');
    }).then(function(r) {
        var row = r.recordset[0];
        if (!row) return res.status(404).json({ error: 'Request not found.' });
        if (row.status !== 'Pending Service' && row.status !== 'Pending Finance') {
            return res.status(400).json({ error: 'Can only override Finance while status is Pending Service or Pending Finance.' });
        }

        return pool.request()
            .input('id', sql.Int, requestId)
            .input('sig', sql.NVarChar, signature.trim())
            .input('comment', sql.NVarChar, comment.trim())
            .query("UPDATE Requests SET status='Pending Warehouse', manager_approved_finance_signature=@sig, manager_approved_finance_date=GETDATE(), manager_approved_finance_comment=@comment WHERE id=@id");
    }).then(function() {
        sendSequentialEmail(pool, requestId, 'override_finance', 'manager', signature, '', comment, false);
        res.json({ success: true });
    }).catch(function(err) {
        res.status(500).json({ error: err.message });
    });
});

module.exports = router;