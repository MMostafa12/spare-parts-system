'use strict';
var db = require('./db');
var sql = db.sql;

function fmtDate(d) {
    if (!d) return '-';
    try {
        if (d instanceof Date) return d.toISOString().split('T')[0];
        return String(d).substring(0, 10);
    } catch (e) { return '-'; }
}

function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildPartsHtml(items) {
    if (!items || items.length === 0) {
        return '<p style="color:#888;">No parts</p>';
    }
    var html = '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
    html += '<tr>' +
        '<th style="border:1px solid #ddd;padding:4px 8px;background:#f5f7fa;text-align:left;">#</th>' +
        '<th style="border:1px solid #ddd;padding:4px 8px;background:#f5f7fa;text-align:left;">Part Name</th>' +
        '<th style="border:1px solid #ddd;padding:4px 8px;background:#f5f7fa;text-align:left;">Part Number</th>' +
        '<th style="border:1px solid #ddd;padding:4px 8px;background:#f5f7fa;text-align:left;">PO Number</th>' +
        '<th style="border:1px solid #ddd;padding:4px 8px;background:#f5f7fa;text-align:center;">QTY</th>' +
        '<th style="border:1px solid #ddd;padding:4px 8px;background:#f5f7fa;text-align:center;">Warehouse Location</th>' +
        '<th style="border:1px solid #ddd;padding:4px 8px;background:#f5f7fa;text-align:center;">Addition Permit</th>' +
        '<th style="border:1px solid #ddd;padding:4px 8px;background:#f5f7fa;text-align:center;">Scrap</th>' +
        '</tr>';
    items.forEach(function (item, idx) {
        var scrap = item.defective_status === 'Y' ? 'Return'
                  : (item.defective_status === 'N' ? 'Scrap' : '-');
        html += '<tr>' +
            '<td style="border:1px solid #ddd;padding:4px 8px;text-align:center;">' + (idx + 1) + '</td>' +
            '<td style="border:1px solid #ddd;padding:4px 8px;">' + esc(item.part_name || '-') + '</td>' +
            '<td style="border:1px solid #ddd;padding:4px 8px;">' + esc(item.part_number || '-') + '</td>' +
            '<td style="border:1px solid #ddd;padding:4px 8px;">' + esc(item.po_number || '-') + '</td>' +
            '<td style="border:1px solid #ddd;padding:4px 8px;text-align:center;">' + (item.quantity || '-') + '</td>' +
            '<td style="border:1px solid #ddd;padding:4px 8px;text-align:center;">' + esc(item.warehouse_location || '-') + '</td>' +
            '<td style="border:1px solid #ddd;padding:4px 8px;text-align:center;">' + esc(item.addition_permit || '-') + '</td>' +
            '<td style="border:1px solid #ddd;padding:4px 8px;text-align:center;">' + scrap + '</td>' +
            '</tr>';
    });
    html += '</table>';
    return html;
}

function buildRequestEmail(opts) {
    var req = opts.req;
    var items = opts.items || [];
    var title = opts.title || 'Request Update';
    var statusColor = opts.statusColor || '#1a3a5c';
    var statusText = opts.statusText || (req.status || '-');
    var actionText = opts.actionText || '';
    var roleText = opts.roleText || '';
    var signature = opts.signature || '';
    var reason = opts.reason || '';
    var comment = opts.comment || '';
    var isFulfilled = !!opts.isFulfilled;

    var partsHtml = buildPartsHtml(items);
    var customerName = req.customer_name || req.organization_name || '';
    var requestDate = fmtDate(req.request_date);

    var dispatchInfo = '';
    if (isFulfilled) {
        dispatchInfo =
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Dispatch Date</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + fmtDate(req.dispatch_date) + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Dispatch Permit</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + esc(req.dispatch_permit_number || '-') + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Receiving Engineer</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + esc(req.receiving_engineer || '-') + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Warehouse Signature</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + esc(req.warehouse_signature || '-') + '</td></tr>';
    }

    // Out-of-hours block
    var outsideHoursBlock = '';
    if (req.out_of_hours_release || req.out_of_hours_return) {
        var fmtDt = function(v) {
            if (!v) return '';
            try {
                var d = new Date(v);
                if (isNaN(d.getTime())) return String(v).substring(0, 16);
                var yyyy = d.getFullYear();
                var mm = ('0' + (d.getMonth() + 1)).slice(-2);
                var dd = ('0' + d.getDate()).slice(-2);
                var hh = ('0' + d.getHours()).slice(-2);
                var mi = ('0' + d.getMinutes()).slice(-2);
                return yyyy + '-' + mm + '-' + dd + ' ' + hh + ':' + mi;
            } catch (e) { return String(v).substring(0, 16); }
        };
        outsideHoursBlock = '<h4 style="color: #8b5a00; margin: 10px 0;">⚠️ Warehouse access outside operating hours</h4>' +
            '<div style="background:#fff8e1;border:1px solid #ffcc80;border-radius:6px;padding:10px;">' +
            '<div><b>1. Part Release:</b> ' + (req.out_of_hours_release ? '✅ Yes' : '❌ No') + (req.out_of_hours_release && req.out_of_hours_release_datetime ? ' &mdash; <b>' + esc(fmtDt(req.out_of_hours_release_datetime)) + '</b>' : '') + '</div>' +
            '<div style="margin-top:6px;"><b>2. Part Return:</b> ' + (req.out_of_hours_return ? '✅ Yes' : '❌ No') + (req.out_of_hours_return && req.out_of_hours_return_datetime ? ' &mdash; <b>' + esc(fmtDt(req.out_of_hours_return_datetime)) + '</b>' : '') + '</div>' +
            '</div>';
    }

    var notesBlock = '';
    (function () {
        var notesHtml = '';
        if (req.notes && String(req.notes).trim() !== '') {
            notesHtml += esc(req.notes);
        }
        if (req.service_approval_notes && String(req.service_approval_notes).trim() !== '') {
            notesHtml += '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #ccc;">' +
                            '<b style="color:#1a3a5c;">📝 Service Notes:</b> ' +
                            esc(req.service_approval_notes) +
                         '</div>';
        }
        if (req.finance_approval_notes && String(req.finance_approval_notes).trim() !== '') {
            notesHtml += '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #ccc;">' +
                            '<b style="color:#1e6b3c;">💵 Finance Notes:</b> ' +
                            esc(req.finance_approval_notes) +
                         '</div>';
        }
        if (req.warehouse_approval_notes && String(req.warehouse_approval_notes).trim() !== '') {
            notesHtml += '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #ccc;">' +
                            '<b style="color:#6c3483;">📦 Warehouse Notes:</b> ' +
                            esc(req.warehouse_approval_notes) +
                         '</div>';
        }
        if (notesHtml !== '') {
            notesBlock = '<h4 style="color: #1a3a5c; margin: 10px 0;">📝 Notes</h4>' +
                         '<div style="background:#f9f9f9;padding:10px;border-radius:6px;border:1px solid #eee;">' +
                         notesHtml +
                         '</div>';
        }
    })();

    return '' +
        '<div style="font-family: Arial, Tahoma, sans-serif; max-width: 650px; margin: 0 auto; padding: 25px; border: 1px solid #ddd; border-radius: 10px;">' +
        '<div style="text-align: center; border-bottom: 3px solid #1a3a5c; padding-bottom: 15px; margin-bottom: 20px;">' +
            '<h2 style="color: #1a3a5c; margin: 0;">' + title + '</h2>' +
            '<p style="color: #888; margin: 5px 0 0;">Request #' + req.id + '</p>' +
        '</div>' +
        '<div style="background: ' + statusColor + '; color: white; padding: 12px 20px; border-radius: 6px; text-align: center; margin-bottom: 20px;">' +
            '<h3 style="margin: 0; font-size: 16px;">' + actionText + '</h3>' +
            '<p style="margin: 5px 0 0; font-size: 14px;">Status: ' + statusText + '</p>' +
        '</div>' +
        '<h3 style="color: #1a3a5c; margin: 15px 0 10px;">📄 Request Details</h3>' +
        '<table style="width:100%;border-collapse:collapse;margin-bottom:15px;">' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;width:40%;">Request ID</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">#' + req.id + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Customer</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + esc(customerName) + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Request Date</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + requestDate + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Department</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + esc(req.department_name || '-') + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Acquisition Type</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + esc(req.acquisition_type || '-') + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Status</td><td style="padding:5px 10px;border-bottom:1px solid #eee;"><span style="background:' + statusColor + ';color:white;padding:2px 10px;border-radius:4px;font-size:12px;">' + statusText + '</span></td></tr>' +
            (reason ? '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Reason</td><td style="padding:5px 10px;border-bottom:1px solid #eee;color:#8b1a1a;">' + esc(reason) + '</td></tr>' : '') +
            (comment ? '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Comment</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + esc(comment) + '</td></tr>' : '') +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Processed By</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + roleText + (signature ? ' - ' + esc(signature) : '') + '</td></tr>' +
            dispatchInfo +
        '</table>' +
        '<h4 style="color: #1a3a5c; margin: 10px 0;">🔧 Parts</h4>' +
        partsHtml +
        notesBlock +
        outsideHoursBlock +
        '<div style="border-top: 1px solid #ddd; padding-top: 15px; margin-top: 20px; text-align: center; color: #888; font-size: 12px;">' +
            '<p style="margin: 0;">نظام قطع الغيار - Medical Technology</p>' +
            '<p style="margin: 0; font-size: 11px;">Spare Parts System</p>' +
            '<p style="margin: 5px 0 0; font-size: 11px;">This is an automated notification. Please do not reply to this email.</p>' +
        '</div>' +
        '</div>';
}

function buildNotesNotificationEmail(opts) {
    var req = opts.req;
    var items = opts.items || [];
    var notesBy = opts.notesBy;
    var notesText = opts.notesText || '';

    var byMap = {
        'service':   { label: 'Service',   color: '#1a3a5c', icon: '📝' },
        'finance':   { label: 'Finance',   color: '#1e6b3c', icon: '💵' },
        'warehouse': { label: 'Warehouse', color: '#6c3483', icon: '📦' }
    };
    var by = byMap[notesBy] || byMap.service;

    var customerName = req.customer_name || req.organization_name || '';
    var requestDate = fmtDate(req.request_date);
    var partsHtml = buildPartsHtml(items);

    var allNotesHtml = '';
    (function () {
        var all = [];
        if (req.notes && String(req.notes).trim() !== '') {
            all.push('<div><b>Requester:</b> ' + esc(req.notes) + '</div>');
        }
        if (req.service_approval_notes && String(req.service_approval_notes).trim() !== '') {
            all.push('<div style="margin-top:6px;"><b>Service:</b> ' + esc(req.service_approval_notes) + '</div>');
        }
        if (req.finance_approval_notes && String(req.finance_approval_notes).trim() !== '') {
            all.push('<div style="margin-top:6px;"><b>Finance:</b> ' + esc(req.finance_approval_notes) + '</div>');
        }
        if (req.warehouse_approval_notes && String(req.warehouse_approval_notes).trim() !== '') {
            all.push('<div style="margin-top:6px;"><b>Warehouse:</b> ' + esc(req.warehouse_approval_notes) + '</div>');
        }
        if (all.length > 0) {
            allNotesHtml = '<h4 style="color: #1a3a5c; margin: 10px 0;">📝 All Notes on This Request</h4>' +
                           '<div style="background:#f9f9f9;padding:10px;border-radius:6px;border:1px solid #eee;font-size:13px;">' +
                           all.join('') +
                           '</div>';
        }
    })();

    return '' +
        '<div style="font-family: Arial, Tahoma, sans-serif; max-width: 650px; margin: 0 auto; padding: 25px; border: 1px solid #ddd; border-radius: 10px;">' +

        '<div style="text-align: center; border-bottom: 3px solid ' + by.color + '; padding-bottom: 15px; margin-bottom: 20px;">' +
            '<h2 style="color: ' + by.color + '; margin: 0;">' + by.icon + ' ' + by.label + ' added a note</h2>' +
            '<p style="color: #888; margin: 5px 0 0;">Request #' + req.id + '</p>' +
        '</div>' +

        '<div style="background: ' + by.color + '; color: white; padding: 12px 20px; border-radius: 6px; text-align: center; margin-bottom: 20px;">' +
            '<h3 style="margin: 0; font-size: 16px;">' + by.label + ' added a note to this request</h3>' +
            '<p style="margin: 5px 0 0; font-size: 14px;">This is an informational notification</p>' +
        '</div>' +

        '<div style="background: #fffdf0; border: 2px dashed ' + by.color + '; border-radius: 8px; padding: 15px; margin-bottom: 20px;">' +
            '<div style="font-size: 12px; color: #888; margin-bottom: 5px;">Note from ' + by.label + ':</div>' +
            '<div style="font-size: 15px; color: #1e2a38; white-space: pre-wrap;">' + esc(notesText) + '</div>' +
        '</div>' +

        '<h3 style="color: #1a3a5c; margin: 15px 0 10px;">📄 Request Summary</h3>' +
        '<table style="width:100%;border-collapse:collapse;margin-bottom:15px;">' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;width:40%;">Request ID</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">#' + req.id + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Customer</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + esc(customerName) + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Request Date</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + requestDate + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Department</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + esc(req.department_name || '-') + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Branch</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + esc(req.branch || 'Cairo') + '</td></tr>' +
            '<tr><td style="padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold;">Current Status</td><td style="padding:5px 10px;border-bottom:1px solid #eee;">' + esc(req.status || '-') + '</td></tr>' +
        '</table>' +

        '<h4 style="color: #1a3a5c; margin: 10px 0;">🔧 Parts</h4>' +
        partsHtml +

        allNotesHtml +

        '<div style="border-top: 1px solid #ddd; padding-top: 15px; margin-top: 20px; text-align: center; color: #888; font-size: 12px;">' +
            '<p style="margin: 0;">نظام قطع الغيار - Medical Technology</p>' +
            '<p style="margin: 0; font-size: 11px;">Spare Parts System</p>' +
            '<p style="margin: 5px 0 0; font-size: 11px;">This is an automated notification. Please do not reply to this email.</p>' +
        '</div>' +

        '</div>';
}

function loadRequestWithItems(pool, requestId) {
    return pool.request()
        .input('id', sql.Int, requestId)
        .query('SELECT * FROM Requests WHERE id = @id')
        .then(function (result) {
            var req = result.recordset[0];
            if (!req) return { req: null, items: [] };
            return pool.request()
                .input('id', sql.Int, requestId)
                .query('SELECT * FROM RequestItems WHERE request_id = @id ORDER BY line_number')
                .then(function (itemsResult) {
                    return { req: req, items: itemsResult.recordset || [] };
                });
        });
}

module.exports = {
    buildPartsHtml: buildPartsHtml,
    buildRequestEmail: buildRequestEmail,
    buildNotesNotificationEmail: buildNotesNotificationEmail,
    loadRequestWithItems: loadRequestWithItems,
    fmtDate: fmtDate
};