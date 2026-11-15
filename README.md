# Bank SDET Practice App

Node.js + Express + SQLite + JWT, Bootstrap UI. Starts **empty** (no users/accounts/transactions).

## Run
```bash
npm install
npm start          # http://localhost:3000   (PORT, JWT_SECRET, DB_FILE env vars optional)
```
Reset all data: stop server, delete `bank.db`. (If you used an older version, delete `bank.db` once.)

| URL | Purpose |
|-|-|
| `/` | UI (`#/login`, `#/dashboard`, `#/accounts`, `#/account/:id`, `#/transactions` = Account History, `#/explorer`) |
| `/api-docs` | Swagger UI |
| `/postman.json` | Postman collection (login request auto-saves `{{token}}` and `{{userId}}`) |
| `/health` | health check |

## Flow
1. `POST /auth/register` → `POST /auth/login` → `{token, userId}` (`userId` = **customerId**, a 6-7 digit number starting at 100001; login/register return both `userId` and `customerId`).
2. `POST /accounts` – open account.
3. `POST /accounts/{id}/kyc` – upload KYC document (separate call).
4. `POST /transactions` – API only (UI shows read-only **Account History**).

## API (all except `/auth/*` need `Authorization: Bearer <token>`)
| Method | Path | Notes |
|-|-|-|
| POST | `/auth/register` | `{name,email,password(>=6)}` → 201 |
| POST | `/auth/login` | → `{token,userId}` |
| POST | `/auth/logout` | stateless |
| GET | `/dashboard` | `{accounts,transactions,totalBalance}` |
| POST | `/accounts` | body below → 201 with generated account number, branch code, IFSC |
| GET | `/accounts` | `page,limit,search,status,accountType,sortBy,order` → `{data,page,limit,total,totalPages}` |
| GET | `/accounts/search` | `customerId` (required) + optional `name,mobileNumber,email` → accounts with `kycDocuments[]`, `nominees[]` |
| GET/PUT/PATCH/DELETE | `/accounts/{id}` | PUT = full replace, PATCH = merge (KYC docs are never changed by PUT/PATCH) |
| POST | `/accounts/{id}/kyc` | `multipart/form-data`: `documentType`, `document` (file), optional `documentNumber` |
| GET | `/accounts/{id}/kyc` | `{kycStatus, kycDocuments[]}` |
| POST/GET | `/transactions` | POST header `Idempotency-Key` optional; GET filters `accountId,transactionType,status` |
| GET | `/transactions/{id}` | |

### Open account
```json
POST /accounts
{ "accountType":"Savings", "username":"John Smith", "customerId":100001, "email":"john@example.com", "panNumber":"ABCDE1234F" }
```
Response (201) is nested by default (`accountNumber` is a generated 12-digit number):
```json
{ "accountId": 1, "customerId": 100001, "accountNumber": "501000000001", "accountType": "Savings", "status": "Active", "balance": 0,
  "kycStatus": "PENDING", "createdAt": "...",
  "branch": { "code": "BR002", "ifscCode": "BANK0000002", "name": "Mumbai Central Branch" },
  "customer": { "customerId": 100001, "name": "John Smith", "email": "john@example.com", "mobileNumber": null, "panNumber": "ABCDE1234F", "aadhaarNumber": null,
    "contacts": [ { "type": "Email", "value": "john@example.com", "primary": true } ], "addresses": [] },
  "kycDocuments": [], "nominees": [] }
```
`customerId` must equal the logged-in `userId` (else **403**); missing → **400**. PAN `ABCDE1234F` format. Optional extras still accepted for nested-JSON practice: `mobileNumber, aadhaarNumber, customer{contacts[],addresses[]}, nominees[] (percentages total 100), balance, status`.

### KYC upload
`documentType`: PAN | AADHAAR | Passport | DrivingLicense | VoterId. File: pdf/png/jpg, max 2MB. Response (201):
```json
{ "message":"Document uploaded successfully", "accountId":1, "documentType":"PAN", "documentId":1, "verified":true, "fileName":"pan.png", "fileSize":1234, "uploadedAt":"..." }
```
Account `kycStatus` becomes `VERIFIED`. Same `documentType` twice → 400. Missing type/file, bad type, wrong file format, >2MB → 400. Only file metadata is stored.
In the **API Explorer**, attach a file and put `documentType=PAN` (one `key=value` per line) in the body box.

### Status codes
| Code | When |
|-|-|
| 400 | validation, invalid JSON, invalid id, duplicate (email / PAN), duplicate KYC type, bad upload, insufficient balance |
| 401 | missing / invalid / expired token, bad login |
| 403 | record belongs to another user, or `customerId` ≠ logged-in user |
| 404 | id not found, or no match in `/accounts/search` |

### Idempotency
- Same `Idempotency-Key` + same payload → **200**, same transaction, `Idempotent-Replay: true`, balance unchanged.
- Same key + different payload → **400**. New key → **201**. No key + identical request within 5 s → **400**.

### Notes
- Email/PAN/idempotency keys are unique **per user**. Deleting an account deletes its transactions. Withdrawals need balance and an `Active` account.
- Test hooks: `row-<accountNumber>`, `txn-<id>`; ids `#addBtn #username #email #panNumber #saveAcc #newAccountNumber #newBranchCode #newIfsc #kycType #kycFile #uploadKyc #kycSuccess #kycVerified #accFilter #txnTable #noRecords`.
