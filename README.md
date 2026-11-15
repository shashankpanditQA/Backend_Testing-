# Bank SDET Practice App

Node.js + Express + SQLite + JWT, Bootstrap UI. Starts **empty** (no users/accounts/transactions).

## Run
```bash
npm install
npm start          # http://localhost:3000   (PORT, JWT_SECRET, DB_FILE env vars optional)
```
Reset all data: stop server, delete `bank.db`.

| URL | Purpose |
|-|-|
| `/` | UI (`#/login`, `#/dashboard`, `#/accounts`, `#/account/:id`, `#/transactions`, `#/explorer`) |
| `/api-docs` | Swagger UI |
| `/postman.json` | Postman collection (Import → Link; login request auto-saves `{{token}}`) |

## API (all except `/auth/*` need `Authorization: Bearer <token>`)
| Method | Path | Notes |
|-|-|-|
| POST | `/auth/register` | `{name,email,password(>=6)}` → 201 `{userId}` |
| POST | `/auth/login` | → `{token,userId}` |
| POST | `/auth/logout` | stateless; client discards token |
| GET | `/dashboard` | `{accounts,transactions,totalBalance}` |
| POST/GET | `/accounts` | GET query: `page,limit,search,status,accountType,sortBy,order` → `{data,page,limit,total,totalPages}` |
| GET/PUT/PATCH/DELETE | `/accounts/{id}` | PUT = full replace, PATCH = merge |
| POST/GET | `/transactions` | POST header `Idempotency-Key` (optional); GET filters `accountId,transactionType,status` |
| GET | `/transactions/{id}` | |

### Account JSON
Example from your spec works as-is (add top-level `email`, or a contact `{type:"Email"}`). Flat fields `accountHolderName, email, mobileNumber, panNumber, aadhaarNumber` are derived from `customer.name`, contacts (Mobile/Email) and `kycDocuments` (PAN/AADHAAR) when omitted. Response always includes `customer{contacts[],addresses[]}`, `kycDocuments[]`, `nominees[]`.

Rules: `accountType` Savings|Current|Salary; `status` Active|Inactive|Closed; required: accountType, accountNumber, accountHolderName, email; mobile 10 digits; PAN `ABCDE1234F`; Aadhaar 12 digits; nominee % must total 100; balance >= 0.

### Status codes
| Code | When |
|-|-|
| 400 | validation, invalid JSON, invalid id, duplicate (account number / PAN / email / Aadhaar), insufficient balance |
| 401 | missing / invalid / expired token, bad login |
| 403 | account/transaction belongs to another user (incl. PUT/PATCH/DELETE, and POST /transactions on foreign account) |
| 404 | id not found |

### Idempotency
- Same `Idempotency-Key` + same payload → **200**, same transaction, header `Idempotent-Replay: true`, balance unchanged.
- Same key + different payload → **400**. New key → **201** new transaction.
- No key + identical request within 5 s → **400** duplicate.

### Design notes
- Uniqueness (account no., email, PAN, Aadhaar, idempotency key) is **per user**, so two users can reuse test data without leaking existence.
- Deleting an account deletes its transactions. Withdrawals need sufficient balance and an `Active` account.
- Test hooks: `data-testid="row-<accountNumber>"`, `txn-<id>`, ids like `#accCount`, `#txnCount`, `#noRecords`, `#addBtn`, `#saveAcc`, `#run`, `#resStatus`, `#resBody`.

## Scenario hints
1. **API→UI**: register+login (API), open Explorer, `POST /accounts`, open Accounts page, assert row.
2. **UI→API**: add account in UI (use `+ Add` for nested rows), `GET /accounts/{id}`, assert nested arrays.
3. **Isolation**: UserA creates account; UserB sees 0 and gets 403 on `GET/PUT/PATCH/DELETE /accounts/{A's id}`.
4. **Negative**: bad/missing token, duplicates, malformed JSON (Explorer sends raw body), missing fields, `/accounts/abc`.
