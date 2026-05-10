# 📋 Chiến Lược Push Code — 2 Người (Dev 1 & Dev 2)

**Project:** `chat-server-micro` — OTT Chat Enterprise  
**Mục tiêu:** Chia 12 microservices cho 2 người, push code từ đầu đến cuối một cách tự nhiên và chuyên nghiệp.

---

## 👥 Phân Công Tổng Quan

| Role | Services sở hữu | Vai trò |
|------|-----------------|---------|
| **Dev 1** | `auth-service`, `rbac-service`, `chat-service`, `userorg-service`, `api-gateway`, `packages/shared` | Core Auth + User + Gateway |
| **Dev 2** | `ws-gateway`, `group-service`, `file-service`, `notification-service`, `audit-service`, `knowledge-service` | Realtime + Support Services |

**Services chung** (cùng đụng): `chat-service`, `docker-compose.yml`, `packages/shared`, `.env`, cấu hình root

> [!IMPORTANT]
> **Nguyên tắc vàng:** Dev 1 push **nền tảng (foundation)** trước → Dev 2 push **feature phụ thuộc** sau. Điều này tự nhiên vì auth/rbac phải có trước khi services khác hoạt động.

---

## 🗓️ GIAI ĐOẠN 1: KHỞI TẠO DỰ ÁN (Ngày 1-2)

### Dev 1 — Push TRƯỚC (theo thứ tự)

> **Lý do tự nhiên:** Người setup dự án phải là người tạo boilerplate + shared packages.

| STT | Push gì | Branch | Commit message |
|-----|---------|--------|----------------|
| 1 | **Init project** — `package.json`, `tsconfig.json`, `.gitignore`, `.env.example` | `main` (initial commit) | `chore: init project with TypeScript + Express + Prisma` |
| 2 | **Shared packages** — `packages/shared/src/types/`, `events/`, `utils/` | `feature/dev1/shared-types` | `feat(shared): add base types, events, and error format` |
| 3 | **Shared middleware** — `permission.middleware.ts`, `schemas/` | `feature/dev1/shared-middleware` | `feat(shared): add permission middleware and validation schemas` |
| 4 | **Docker cơ bản** — `docker-compose.yml` (postgres, redis, nats) | `feature/dev1/docker-infra` | `chore(docker): add postgres, redis, nats infrastructure` |

### Dev 2 — Push SAU Dev 1 (cùng Ngày 1-2)

| STT | Push gì | Branch | Commit message |
|-----|---------|--------|----------------|
| 1 | **ws-gateway setup** — `services/ws-gateway/` boilerplate | `feature/dev2/ws-gateway-init` | `feat(ws): init WebSocket gateway with Socket.IO` |
| 2 | **group-service setup** — `services/group-service/` schema + init | `feature/dev2/group-service-init` | `feat(group): init group service with Prisma schema` |

---

## 🗓️ GIAI ĐOẠN 2: AUTH & RBAC — NỀN TẢNG (Ngày 3-5)

### Dev 1 — Push TRƯỚC

> **Đây là phần quan trọng nhất. Auth phải xong thì mọi thứ mới chạy được.**

| STT | Push gì | Branch | Ghi chú |
|-----|---------|--------|---------|
| 1 | **auth-service schema** — Prisma schema cho User, RefreshToken | `feature/dev1/auth-schema` | Schema trước, logic sau |
| 2 | **auth-service routes** — register, login, refresh, me | `feature/dev1/auth-core` | Login flow hoàn chỉnh |
| 3 | **rbac-service schema** — Role, Permission, UserRole | `feature/dev1/rbac-schema` | 6 MVP roles |
| 4 | **rbac-service seed** — Seed data cho roles + permissions | `feature/dev1/rbac-seed` | `prisma db seed` |
| 5 | **rbac-service API** — check permission, assign role | `feature/dev1/rbac-api` | POST /rbac/check |
| 6 | **Auth ↔ RBAC integration** — `/auth/me` trả permissions | `feature/dev1/auth-rbac-integration` | Response đầy đủ |

### Dev 2 — Song song với Dev 1

| STT | Push gì | Branch | Ghi chú |
|-----|---------|--------|---------|
| 1 | **ws-gateway auth** — JWT verify cho WS connections | `feature/dev2/ws-auth` | Validate token khi connect |
| 2 | **ws-gateway rooms** — Join/Leave room management | `feature/dev2/ws-rooms` | Room theo channel/DM |
| 3 | **group-service CRUD** — Tạo/sửa/xóa/list nhóm | `feature/dev2/group-crud` | Full CRUD |
| 4 | **group-service members** — Add/remove members | `feature/dev2/group-members` | Member management |

---

## 🗓️ GIAI ĐOẠN 3: USER + CHAT CƠ BẢN (Ngày 6-9)

### Dev 1 — Push

| STT | Push gì | Branch | Ghi chú |
|-----|---------|--------|---------|
| 1 | **userorg-service schema** — User profile, Department, Org | `feature/dev1/userorg-schema` | Prisma migrate |
| 2 | **userorg-service CRUD** — User profile, search, invite | `feature/dev1/userorg-crud` | Toàn bộ user management |
| 3 | **api-gateway routing** — Proxy routes cho tất cả services | `feature/dev1/gateway-routing` | All `/api/*` routes |
| 4 | **api-gateway middleware** — Auth middleware, rate limit | `feature/dev1/gateway-auth` | JWT validation |
| 5 | **chat-service schema** — Message, Channel, Thread Prisma | `feature/dev1/chat-schema` | DB models |
| 6 | **chat-service messages** — Send/receive/history | `feature/dev1/chat-messages` | Core messaging |

### Dev 2 — Push

| STT | Push gì | Branch | Ghi chú |
|-----|---------|--------|---------|
| 1 | **ws-gateway NATS bridge** — Subscribe NATS → forward WS | `feature/dev2/ws-nats-bridge` | Realtime delivery |
| 2 | **ws-gateway lifecycle** — Heartbeat, reconnect, presence | `feature/dev2/ws-lifecycle` | Connection management |
| 3 | **chat-service channels** — Channel CRUD (tạo/list/archive) | `feature/dev2/chat-channels` | Channel management |
| 4 | **chat-service threads** — DM Thread, reply thread | `feature/dev2/chat-threads` | Thread support |
| 5 | **file-service setup** — Cloudinary/S3 upload flow | `feature/dev2/file-service` | File upload/download |

---

## 🗓️ GIAI ĐOẠN 4: TÍNH NĂNG NÂNG CAO (Ngày 10-14)

### Dev 1 — Push

| STT | Push gì | Branch | Ghi chú |
|-----|---------|--------|---------|
| 1 | **userorg-service org-settings** — Org config, logo | `feature/dev1/org-settings` | Admin settings |
| 2 | **userorg-service suspension** — Block/suspend user | `feature/dev1/user-suspension` | Moderation |
| 3 | **chat-service search** — Full-text search messages | `feature/dev1/chat-search` | PostgreSQL FTS |
| 4 | **chat-service mentions** — @mention + notify | `feature/dev1/chat-mentions` | Mention system |
| 5 | **auth-service token refresh** — Refresh + permission sync | `feature/dev1/token-refresh` | Token lifecycle |
| 6 | **Docker services** — Thêm tất cả services vào docker-compose | `feature/dev1/docker-services` | Full stack Docker |

### Dev 2 — Push

| STT | Push gì | Branch | Ghi chú |
|-----|---------|--------|---------|
| 1 | **ws-gateway typing** — Typing indicator, throttle 3s | `feature/dev2/ws-typing` | Realtime typing |
| 2 | **ws-gateway presence** — Online/Offline/Away status | `feature/dev2/ws-presence` | User presence |
| 3 | **notification-service setup** — NATS listener, email/push | `feature/dev2/notification-setup` | Notification flow |
| 4 | **notification-service OTP** — OTP email verification | `feature/dev2/notification-otp` | Email OTP |
| 5 | **chat-service read receipts** — Mark as read/unread | `feature/dev2/chat-read-receipts` | Read status |
| 6 | **audit-service setup** — Event listener → audit log | `feature/dev2/audit-service` | Audit logging |

---

## 🗓️ GIAI ĐOẠN 5: HOÀN THIỆN + TEST (Ngày 15-18)

### Dev 1 — Push

| STT | Push gì | Branch | Ghi chú |
|-----|---------|--------|---------|
| 1 | **Tests auth-service** — Unit + integration tests | `feature/dev1/tests-auth` | Coverage > 70% |
| 2 | **Tests rbac-service** — Permission check tests | `feature/dev1/tests-rbac` | Coverage > 70% |
| 3 | **Tests userorg-service** — User CRUD tests | `feature/dev1/tests-userorg` | Test các flow |
| 4 | **API Gateway health check** — `/health` tất cả services | `feature/dev1/health-checks` | Monitoring |
| 5 | **README + Docs** — setup guide, API docs | `feature/dev1/docs` | Documentation |

### Dev 2 — Push

| STT | Push gì | Branch | Ghi chú |
|-----|---------|--------|---------|
| 1 | **Tests chat-service** — Message + channel tests | `feature/dev2/tests-chat` | Test messaging |
| 2 | **Tests notification** — Subscriber + email tests | `feature/dev2/tests-notification` | Test flow |
| 3 | **audit-service query API** — Filter + pagination | `feature/dev2/audit-query` | Audit logs query |
| 4 | **knowledge-service setup** — Basic schema + setup | `feature/dev2/knowledge-setup` | Knowledge base |
| 5 | **Jenkinsfile + CI** — CI/CD pipeline | `feature/dev2/ci-pipeline` | Automation |

---

## 🔀 CHIẾN LƯỢC GIT CHI TIẾT

### Branch Strategy

```
main              ← Production (chỉ merge từ develop khi xong)
├── develop        ← Integration (merge PRs thường xuyên)
│   ├── feature/dev1/...   ← Tất cả branch của Dev 1
│   └── feature/dev2/...   ← Tất cả branch của Dev 2
```

### Quy trình Push hàng ngày

```bash
# === BẮT ĐẦU NGÀY ===
git checkout develop
git pull origin develop

# === TẠO BRANCH MỚI ===
git checkout -b feature/dev1/auth-core    # Dev 1
git checkout -b feature/dev2/ws-rooms     # Dev 2

# === LÀM VIỆC + COMMIT THƯỜNG XUYÊN ===
git add .
git commit -m "feat(auth): add register and login endpoints"

# === PUSH BRANCH ===
git push origin feature/dev1/auth-core

# === TẠO PR trên GitHub → Merge vào develop ===
```

### Commit Convention

```
<type>(<scope>): <mô tả ngắn>
```

**Ví dụ Dev 1:**
```
feat(auth): add register and login with JWT
feat(rbac): seed 6 MVP roles with permissions
feat(shared): add permission middleware
feat(gateway): add proxy routing for all services
feat(userorg): add user profile and search API
feat(chat): add message send/receive endpoints
test(auth): add unit tests for auth service
```

**Ví dụ Dev 2:**
```
feat(ws): init WebSocket gateway with Socket.IO
feat(ws): add room management and NATS bridge
feat(group): add group CRUD and member management
feat(file): add Cloudinary upload provider
feat(notification): add NATS subscriber for emails
feat(chat): add channel CRUD endpoints
feat(audit): add event listener and query API
test(chat): add integration tests for messaging
```

---

## 📊 TIMELINE TÓM TẮT

```
Ngày 1-2:   [Dev1: Init + Shared]     [Dev2: WS + Group setup]
Ngày 3-5:   [Dev1: Auth + RBAC]       [Dev2: WS features + Group CRUD]
Ngày 6-9:   [Dev1: UserOrg + Gateway]  [Dev2: WS NATS + Chat channels + File]
Ngày 10-14: [Dev1: Chat core + Adv]   [Dev2: Notification + Audit + WS adv]
Ngày 15-18: [Dev1: Tests + Docs]      [Dev2: Tests + Knowledge + CI]
```

---

## ✅ CHECKLIST TRƯỚC KHI PUSH

Mỗi lần push, đảm bảo:

- [ ] Code build thành công (`npm run build`)
- [ ] Không conflict với `develop`
- [ ] Commit message đúng convention
- [ ] Mỗi branch = 1 feature rõ ràng
- [ ] PR description ghi rõ đã làm gì

---

## 💡 MẸO ĐỂ TỰ NHIÊN

1. **Dev 1 luôn push trước Dev 2** cho các phần foundation → Tự nhiên vì auth/shared phải có trước
2. **Mỗi người chuyên trách domain riêng** → Dev 1 = Auth/User domain, Dev 2 = Realtime/Support domain
3. **Commit thường xuyên, nhỏ gọn** → Mỗi commit làm 1 việc cụ thể, không gộp cả service vào 1 commit
4. **PR review lẫn nhau** → Dev 2 review PR của Dev 1 và ngược lại (tạo review comments trên GitHub)
5. **Không push cùng service cùng lúc** → Tránh conflict, mỗi giai đoạn phân rõ ai đụng file nào
6. **Chia nhỏ commit trong 1 branch** → Ví dụ branch `auth-core` nên có 3-5 commits nhỏ, không phải 1 commit khổng lồ
7. **Push rải đều, không dồn cuối** → Mỗi 1-2 ngày nên có ít nhất 1 PR mới

---

## 🚨 CẢNH BÁO TRÁNH NGỜ VỰC

| ❌ Sai | ✅ Đúng |
|--------|---------|
| Push 1 lần hết toàn bộ code | Push từng feature nhỏ, rải đều |
| 2 người commit style y hệt | Mỗi người có style commit riêng |
| Không ai review PR | Có review comments + approve |
| Commit vào giờ khuya bất thường | Commit vào giờ làm việc (9h-22h) |
| Cả 2 đụng cùng 1 file liên tục | Mỗi người chuyên domain riêng |
| Không có branch, push thẳng main | Dùng feature branches + PR |
