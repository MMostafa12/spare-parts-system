# Spare Parts Management System

A full-stack web application for managing spare parts requests across multiple departments and branches, with a multi-stage approval workflow and bilingual (Arabic/English) interface.

## Features

- Multi-role authentication (requester, service, finance, warehouse, dept manager, manager)
- Multi-stage approval workflow: Service → Finance → Warehouse
- Separate Alexandria branch dept-manager approval flow
- Bilingual UI (Arabic RTL / English) with language toggle
- A4 print-ready Arabic request form
- Organization & parts search integrated with MIERP2 ERP
- Automatic email notifications to approvers and requesters

## Tech Stack

- **Backend:** Node.js, Express.js
- **Database:** Microsoft SQL Server (mssql package)
- **Frontend:** Vanilla HTML / CSS / JavaScript
- **Email:** Nodemailer
- **Deployment:** NSSM (Windows Service)

## Setup

1. Run `npm install`
2. Copy `.env.example` to `.env` and fill in your credentials
3. Run `node app.js`
4. Open http://localhost:your port

## Author

[Mohamed Mostafa Ibrahim]