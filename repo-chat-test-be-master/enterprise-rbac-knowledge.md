# 🏢 Enterprise RBAC + Permission-Aware RAG System

> **Dự án:** Hệ thống Chat nội bộ doanh nghiệp với AI Knowledge Base
> **Target:** < 500 concurrent users
> **Kiến trúc:** Microservices (Node.js + NATS + Prisma)

---

## 📋 Overview

Triển khai hệ thống **Role-Based Access Control (RBAC)** chuẩn enterprise với **Permission-Aware RAG** cho chat server. Hệ thống bao gồm:

1. **9 Role types** (MVP: 6 roles)
2. **Permission-aware RAG pipeline** - AI chỉ trả lời tài liệu user được phép
3. **Knowledge Management** với multi-source connectors
4. **Audit logging** cho compliance

### P0 Decisions (User Confirmed)

| Quyết định | Lựa chọn | Impact |
|------------|----------|--------|
| Admin đọc DM | ✅ Có | RBAC + Audit Log (không cần E2EE) |
| Nguồn tri thức | ✅ Tất cả | Connector + Permission Mapping + Scheduler |
| ACL tài liệu | ✅ Tất cả | **Permission-aware RAG (bắt buộc)** |
| Concurrent | < 500 | WebSocket + DB đủ, không cần Redis/Kafka |

---

## 🎯 Success Criteria

- [ ] 6 MVP roles hoạt động đúng với permission matrix
- [ ] Permission-aware RAG: AI chỉ trả lời tài liệu user được phép xem
- [ ] Audit log ghi nhận tất cả admin actions
- [ ] Knowledge ingestion pipeline: Upload → Parse → Chunk → Embed → Index
- [ ] Multi-source connector: Local files, (chuẩn bị cho GDrive/SharePoint)

---

## 🏗️ Project Type

**BACKEND** - API/Microservices architecture

**Primary Agent:** `backend-specialist`
**Supporting Skills:** `database-design`, `api-patterns`, `clean-code`

---

## 🛠️ Tech Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Runtime** | Node.js + TypeScript | Existing stack |
| **Database** | PostgreSQL/MariaDB + Prisma | Existing ORM |
| **Realtime Bus** | NATS | Chat Events, Presence, Notifications (Low latency) |
| **Task Queue** | **RabbitMQ [NEW]** | File Processing, RAG Ingestion, Email Jobs (Reliability) |
| **AI Backend** | **Spring AI (Existing)** | User đã có sẵn Spring backend xử lý RAG/LLM |
| **Vector DB** | Managed by Spring AI | Spring AI backend quản lý vector storage |
| **Integration** | HTTP Client / REST | Node.js gọi Spring AI API |

---

## 🏗️ Hybrid Messaging Architecture (Option A)

**Chiến lược:** Sử dụng đúng công cụ cho đúng việc (Best-of-breed).

### 1. NATS (Real-time Layer) 🚀
- **Use Cases:** Chat mesages, Typing indicators, User presence (Online/Offline), Notifications.
- **Why:** Low latency, Lightweight, Pub/Sub performance.
- **Pattern:** Fire-and-forget hoặc Request-Reply cho RPC nhẹ.

### 2. RabbitMQ (Async Job Layer) 🐢🛡️
- **Use Cases:** File Upload processing, Virus Scan, RAG Document Ingestion, Email sending.
- **Why:** Reliability, persistent queues, ACK/NACK mechanism, DLQ (Dead Letter Queue).
- **Pattern:** Work Queue (Producer -> Queue -> Worker).

---

## 👥 Role System (9 Roles, MVP: 7)

### Full System Roles

| # | Role | Level | Access Scope |
|---|------|-------|--------------|
| 🔴 1 | **Super Admin** | System | Toàn bộ hệ thống, config bảo mật |
| 🟠 2 | **Org Admin** | Organization | Quản lý users, workspace, đọc chat/DM |
| 🟡 3 | **Security Officer** | Compliance | Audit log, investigation, legal hold |
| 🟢 4 | **Workspace Manager** | Workspace | Quản lý channels, thành viên, moderation |
| 🔵 5 | **Employee** | Standard | Chat, AI, Knowledge theo ACL |
| 🟣 6 | **External Guest** | Limited | Chỉ channel được mời |
| 🧠 7 | **Knowledge Admin** | Knowledge | Quản lý sources, collections, ACL |
| ✍️ 8 | **Knowledge Curator** | Content | Upload, gán nhãn tài liệu |
| 🤖 9 | **AI Admin** | AI Config | RAG config, prompt, embedding |

---

### 🔴 1. Super Admin (System Owner)

> **Mức độ:** Cao nhất – "Chìa khóa trao tay"
> 
> ⚠️ **Lưu ý:** Role này nắm quyền sinh sát của hệ thống, tuyệt đối không giao cho nhân sự vận hành thông thường.

| Category | Quyền hạn |
|----------|-----------|
| **Tenant Management** | Quản lý toàn bộ Tenant / Tổ chức |
| **Security Policies** | Cấu hình bảo mật toàn hệ thống |
| **AI & Data Control** | Bật/tắt các tính năng AI, Chat, Knowledge Base toàn cục |
| **Data Export** | Có quyền xem và export toàn bộ dữ liệu (bao gồm cả log hệ thống) |

**Permissions:**
```
system.*                    # Full system access
security.config.*           # Security policies
ai.config.*                 # AI features toggle
data.export.*               # Export all data
audit.read.*                # Read all audit logs
```

---

### 🟠 2. Org Admin (Admin Doanh nghiệp / IT)

> **Mức độ:** Quản trị vận hành nội bộ & Hạ tầng

| Category | Quyền hạn |
|----------|-----------|
| **User Management** | Tạo user, gán role (vai trò), phân chia phòng ban |
| **Workspace Management** | Quản lý chung các Workspace và Channel |
| **Monitoring** | Xem báo cáo sử dụng (Usage Reports) |
| **Retention Policy** | Cấu hình thời gian lưu trữ dữ liệu (30/90/365 ngày) |
| **DM Access** | Có thể đọc Chat + Direct Message (DM) khi cần thiết (theo chính sách công ty) |

**Permissions:**
```
user.create, user.update, user.delete     # User CRUD
user.role.assign                          # Assign roles (< own level)
workspace.manage                          # Manage workspaces
channel.read.org                          # Read all org channels
dm.read.org                               # Read DMs (AUDITED)
report.usage.read                         # Usage reports
retention.config                          # Data retention
```

---

### 🟡 3. Security / Compliance Officer

> **Mức độ:** Kiểm soát & Pháp lý (Role "chuẩn doanh nghiệp")
>
> 📌 Không can thiệp vào vận hành hàng ngày, chỉ tập trung vào tuân thủ.

| Category | Quyền hạn |
|----------|-----------|
| **Audit** | Xem Audit Log để giám sát hoạt động hệ thống |
| **Investigation** | Điều tra các sự cố bảo mật hoặc vi phạm chính sách |
| **Legal Hold** | Thực hiện Legal Hold (giữ dữ liệu phục vụ pháp lý) |
| **Evidence Export** | Export dữ liệu theo vụ việc (case) |

**Permissions:**
```
audit.read.*                              # Read all audit logs
audit.export                              # Export audit logs
legal.hold.create                         # Create legal holds
legal.hold.manage                         # Manage legal holds
investigation.create                      # Open investigations
data.export.case                          # Export by case
```

**Restrictions:**
```
❌ user.create, user.delete               # Cannot manage users
❌ channel.manage                          # Cannot manage channels
❌ dm.read                                  # Cannot read DMs (without investigation)
```

---

### 🟢 4. Workspace / Community Manager (Ops / Moderator)

> **Mức độ:** Quản lý vận hành cộng đồng & Chat
>
> 📌 Bao gồm quyền của **Channel Owner** trong phạm vi workspace được gán.

| Category | Quyền hạn |
|----------|-----------|
| **Channel Management** | Tạo mới hoặc đóng (archive/delete) channel |
| **Member Management** | Quản lý thành viên trong các kênh public (thêm/mời/kick) |
| **Moderation** | Xử lý report, ẩn/xoá tin nhắn vi phạm trong kênh công khai |
| **Announcements** | Ghim (pin) thông báo quan trọng |

**Permissions:**
```
channel.create, channel.archive, channel.delete   # Channel CRUD
channel.member.add, channel.member.remove         # Member management
message.hide, message.delete                      # Moderation
message.pin                                       # Pin messages
report.handle                                     # Handle reports
```

**Restrictions (Giới hạn):**
```
❌ ai.config.*                             # Cannot configure AI
❌ knowledge.*                             # Cannot manage Knowledge Base
❌ security.*                              # Cannot access security settings
❌ user.role.assign                        # Cannot assign roles
```

---

### 🔵 5. Employee (User thường)

> **Mức độ:** Người dùng chính thức

| Category | Quyền hạn |
|----------|-----------|
| **Communication** | Chat 1-1, chat nhóm, tham gia các kênh được phân quyền |
| **File Management** | Upload file theo chính sách; tìm kiếm tin nhắn trong phạm vi cho phép |
| **AI Features** | Hỏi AI trong chat, nhờ AI tóm tắt thread, soạn thảo câu trả lời |
| **Ask Knowledge** | Hỏi AI về tri thức công ty (AI chỉ trả lời dựa trên tài liệu mà user đó có quyền truy cập) |

**Permissions:**
```
chat.read.own, chat.write.own             # Chat in joined channels
dm.read.own, dm.write.own                 # Direct messages
file.upload, file.download                # File operations (policy limited)
search.message                            # Search messages
ai.ask                                    # Ask AI
ai.summarize                              # AI summarize thread
ai.compose                                # AI draft response
knowledge.ask                             # Ask Knowledge (ACL filtered)
```

---

### 🟣 6. External Guest (Đối tác / Khách)

> **Mức độ:** Hạn chế (Guest Access)

| Category | Quyền hạn |
|----------|-----------|
| **Access** | Chỉ được vào các Guest Workspace hoặc kênh cụ thể được mời |
| **Communication** | Chat trong kênh được mời |

**Permissions:**
```
chat.read.invited                         # Read invited channels only
chat.write.invited                        # Write in invited channels only
file.download.unrestricted               # Download non-restricted files
```

**Restrictions (Bảo mật):**
```
❌ knowledge.read                          # Cannot access Knowledge Base
❌ knowledge.ask                           # Cannot ask AI about company knowledge
❌ file.download.restricted               # Cannot download restricted files
❌ dm.write                                 # Cannot initiate DMs (tùy policy)
❌ search.*                                 # Cannot search messages
```

---

### 🧠 7. Knowledge Admin *(Phase 2)*

> **Mức độ:** Quản lý Knowledge Base

| Category | Quyền hạn |
|----------|-----------|
| **Source Management** | Quản lý nguồn dữ liệu (GDrive, SharePoint, Confluence) |
| **Collection Management** | Tạo/sửa/xóa Collections |
| **ACL Control** | Gán quyền truy cập tài liệu cho users/teams |

**Permissions:**
```
knowledge.source.manage                   # Manage data sources
knowledge.collection.*                    # Collection CRUD
knowledge.acl.*                           # ACL management
knowledge.document.approve               # Approve documents for AI
```

---

### ✍️ 8. Knowledge Curator *(Phase 2)*

> **Mức độ:** Content Management

| Category | Quyền hạn |
|----------|-----------|
| **Document Upload** | Upload tài liệu vào Collections được gán |
| **Tagging** | Gán nhãn, phân loại tài liệu |
| **Metadata** | Cập nhật metadata tài liệu |

**Permissions:**
```
knowledge.document.upload                 # Upload documents
knowledge.document.tag                    # Tag documents
knowledge.document.update                 # Update metadata
```

---

### 🤖 9. AI Admin *(Phase 2)*

> **Mức độ:** AI Configuration

| Category | Quyền hạn |
|----------|-----------|
| **RAG Config** | Cấu hình retrieval settings |
| **Prompt Management** | Quản lý system prompts |
| **Model Selection** | Chọn LLM model cho từng use case |

**Permissions:**
```
ai.rag.config                             # RAG settings
ai.prompt.manage                          # System prompts
ai.model.select                           # Model selection
ai.usage.monitor                          # Monitor AI usage
```

---

### MVP Roles (Phase 1)

```
1. Super Admin       ← Full system access
2. Org Admin         ← IT/HR operations
3. Security Officer  ← Compliance
4. Workspace Manager ← Channel/Community ops
5. Employee          ← Standard user
6. External Guest    ← Limited access
```

### Phase 2 Roles (AI & Knowledge)

```
7. Knowledge Admin   ← KB management
8. Knowledge Curator ← Content upload
9. AI Admin          ← AI configuration
```

---

## 📁 File Structure (New Services/Modules)

```
chat-server-micro/
├── services/
│   ├── rbac-service/           # [NEW] Role-Based Access Control
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── services/
│   │   │   │   ├── role.service.ts
│   │   │   │   ├── permission.service.ts
│   │   │   │   └── policy.service.ts
│   │   │   ├── routes/
│   │   │   │   └── rbac.routes.ts
│   │   │   ├── lib/
│   │   │   └── prisma/
│   │   │       └── schema.prisma
│   │   └── package.json
│   │
│   ├── knowledge-service/      # [NEW] Knowledge Management
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── services/
│   │   │   │   ├── document.service.ts
│   │   │   │   ├── collection.service.ts
│   │   │   │   ├── ingestion.service.ts
│   │   │   │   └── acl.service.ts
│   │   │   ├── connectors/
│   │   │   │   ├── local.connector.ts
│   │   │   │   ├── gdrive.connector.ts    # Phase 2
│   │   │   │   └── sharepoint.connector.ts # Phase 2
│   │   │   ├── pipeline/
│   │   │   │   ├── parser.ts
│   │   │   │   ├── chunker.ts
│   │   │   │   └── embedder.ts
│   │   │   ├── routes/
│   │   │   └── prisma/
│   │   │       └── schema.prisma
│   │   └── package.json
│   │
│   ├── # AI/RAG xử lý bởi Spring AI Backend (EXISTING)
│   │   # Không cần tạo ai-service trong Node.js
│   │   # Integration thông qua packages/shared/src/clients/
│   │
│   ├── audit-service/          # [NEW] Audit Logging
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── services/
│   │   │   │   └── audit.service.ts
│   │   │   └── routes/
│   │   └── package.json
│   │
│   ├── job-worker-service/     # [NEW] RabbitMQ Consumers
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── consumers/
│   │   │   │   ├── file-process.consumer.ts
│   │   │   │   ├── rag-ingest.consumer.ts
│   │   │   │   └── email.consumer.ts
│   │   │   ├── config/
│   │   │   │   └── rabbitmq.config.ts
│   │   └── package.json
│   │
│   ├── auth-service/           # [MODIFY] Thêm role assignment
│   ├── userorg-service/        # [MODIFY] Link với RBAC
│   └── chat-service/           # [MODIFY] Permission checking
│
└── packages/
    └── shared/
        └── src/
            ├── types/
            │   ├── rbac.types.ts       # [NEW]
            │   ├── knowledge.types.ts  # [NEW]
            │   └── events.types.ts     # [NEW] RabbitMQ payloads
            ├── constants/
            │   ├── permissions.ts       # [NEW]
            │   └── queues.ts            # [NEW] Queue names
            └── clients/
                ├── spring-ai.client.ts  # [NEW] HTTP client to Spring AI
                └── rabbitmq.client.ts   # [NEW] Publisher client
```

---

## 📊 Database Schema (New Tables)

### RBAC Schema

```prisma
// rbac-service/src/prisma/schema.prisma

model Role {
  id          String   @id @default(uuid())
  name        String   @unique  // SUPER_ADMIN, ORG_ADMIN, etc.
  displayName String
  level       Int      // Hierarchy level (0 = highest)
  isSystem    Boolean  @default(false)  // Built-in roles
  createdAt   DateTime @default(now())
  
  permissions RolePermission[]
  users       UserRole[]
}

model Permission {
  id          String   @id @default(uuid())
  resource    String   // chat, dm, knowledge, user, etc.
  action      String   // read, write, delete, admin
  scope       String   @default("own") // own, team, org, system
  
  roles       RolePermission[]
  
  @@unique([resource, action, scope])
}

model RolePermission {
  roleId       String
  permissionId String
  
  role         Role       @relation(fields: [roleId], references: [id])
  permission   Permission @relation(fields: [permissionId], references: [id])
  
  @@id([roleId, permissionId])
}

model UserRole {
  userId    String
  roleId    String
  scope     String?   // orgId, workspaceId - for scoped roles
  grantedBy String
  grantedAt DateTime  @default(now())
  
  role      Role   @relation(fields: [roleId], references: [id])
  
  @@id([userId, roleId])
}
```

### Knowledge Schema

```prisma
// knowledge-service/src/prisma/schema.prisma

model Collection {
  id          String   @id @default(uuid())
  name        String
  description String?
  isPublic    Boolean  @default(false)
  createdBy   String
  createdAt   DateTime @default(now())
  
  documents   Document[]
  acl         CollectionACL[]
}

model CollectionACL {
  id           String   @id @default(uuid())
  collectionId String
  
  // Access can be by user, role, department, or group
  accessType   String   // USER, ROLE, DEPARTMENT, GROUP
  accessId     String   // userId/roleId/deptId/groupId
  permission   String   // READ, WRITE, ADMIN
  
  collection   Collection @relation(fields: [collectionId], references: [id])
  
  @@unique([collectionId, accessType, accessId])
}

model Document {
  id             String   @id @default(uuid())
  collectionId   String
  
  title          String
  sourceType     String   // UPLOAD, GDRIVE, SHAREPOINT, CONFLUENCE
  sourceUrl      String?
  filePath       String?
  mimeType       String
  
  // Classification
  classification String   @default("INTERNAL") // PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED
  department     String?
  project        String?
  tags           String[] 
  
  // Processing state
  status         String   @default("PENDING") // PENDING, PROCESSING, READY, ERROR
  
  createdBy      String
  approvedBy     String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  
  collection     Collection @relation(fields: [collectionId], references: [id])
  chunks         DocumentChunk[]
}

model DocumentChunk {
  id          String   @id @default(uuid())
  documentId  String
  
  content     String
  metadata    Json     // heading, section, page, etc.
  embedding   Float[]  // Using pgvector
  chunkIndex  Int
  
  document    Document @relation(fields: [documentId], references: [id])
  
  @@index([embedding], type: Hnsw(ops: VectorCosineOps))
}
```

### Audit Schema

```prisma
// audit-service/src/prisma/schema.prisma

model AuditLog {
  id         String   @id @default(uuid())
  
  userId     String
  action     String   // LOGIN, LOGOUT, READ_DM, CREATE_USER, etc.
  resource   String   // user, chat, dm, document, etc.
  resourceId String?
  
  data       Json?    // Additional context
  ipAddress  String?
  userAgent  String?
  
  timestamp  DateTime @default(now())
  
  @@index([userId])
  @@index([action])
  @@index([resource])
  @@index([timestamp])
}
```

---

## 📋 Task Breakdown

### Phase 1: Foundation (RBAC Core)

#### Task 1.1: RBAC Service Setup
- **Agent:** `backend-specialist`
- **Skills:** `database-design`, `clean-code`
- **Priority:** P0
- **Dependencies:** None

**INPUT:** User requirements for 6 MVP roles
**OUTPUT:** 
- `rbac-service/` folder structure
- Prisma schema with Role, Permission, RolePermission, UserRole
- Database migration applied

**VERIFY:**
- [ ] `prisma migrate dev` runs without error
- [ ] Can query roles and permissions

---

#### Task 1.2: Seed Default Roles & Permissions
- **Agent:** `backend-specialist`
- **Priority:** P0
- **Dependencies:** Task 1.1

**INPUT:** Role definitions from design
**OUTPUT:** Seed script populating:
- 6 MVP roles
- Permission matrix

**VERIFY:**
- [ ] `prisma db seed` creates all roles
- [ ] Permission matrix matches spec

---

#### Task 1.3: RBAC Service API
- **Agent:** `backend-specialist`
- **Skills:** `api-patterns`
- **Priority:** P0
- **Dependencies:** Task 1.2

**INPUT:** RBAC service setup
**OUTPUT:** API endpoints:
- `POST /roles` - Create role (Super Admin)
- `GET /roles` - List roles
- `POST /users/:id/roles` - Assign role
- `DELETE /users/:id/roles/:roleId` - Remove role
- `GET /users/:id/permissions` - Get user permissions
- `POST /check` - Check permission

**VERIFY:**
- [ ] Each endpoint returns correct response
- [ ] Role hierarchy enforced (can't assign higher role)

---

#### Task 1.4: Auth Service Integration
- **Agent:** `backend-specialist`
- **Priority:** P1
- **Dependencies:** Task 1.3

**INPUT:** Existing auth-service
**OUTPUT:**
- Modify signUp to assign default `EMPLOYEE` role
- Modify JWT payload to include roles
- Add role to token validation response

**VERIFY:**
- [ ] New user gets EMPLOYEE role
- [ ] JWT contains role info
- [ ] Role can be verified in other services

---

#### Task 1.5: Permission Middleware
- **Agent:** `backend-specialist`
- **Priority:** P1
- **Dependencies:** Task 1.4

**INPUT:** RBAC service
**OUTPUT:** Shared middleware:
```typescript
// Usage: requirePermission('chat', 'read', 'org')
requirePermission(resource: string, action: string, scope?: string)
```

**VERIFY:**
- [ ] Middleware blocks unauthorized access
- [ ] Proper error messages returned

---

### Phase 1.5: Async Job Infra (RabbitMQ)

#### Task 1.6: RabbitMQ Setup & Job Service
- **Agent:** `backend-specialist`
- **Priority:** P1
- **Dependencies:** Task 1.1
- **Skills:** `nodejs-best-practices`

**INPUT:** RabbitMQ connection info
**OUTPUT:** 
- `job-worker-service` setup
- RabbitMQ connection / Exchange / Queue definitions:
  - `q.file.process`
  - `q.rag.ingest`
  - `q.email.send`
  - `dlq.general` (Dead Letter Queue)

**VERIFY:**
- [ ] RabbitMQ connected
- [ ] Queues created in Management UI

#### Task 1.7: Shared RabbitMQ Client
- **Agent:** `backend-specialist`
- **Priority:** P1
- **Dependencies:** Task 1.6

**OUTPUT:** `packages/shared/src/clients/rabbitmq.client.ts` to publish messages.
```typescript
publishJob(queue: string, payload: any, options?: Options)
```

**VERIFY:**
- [ ] Can publish message from other services

---

### Phase 2: Knowledge Service

#### Task 2.1: Knowledge Service Setup
- **Agent:** `backend-specialist`
- **Skills:** `database-design`
- **Priority:** P1
- **Dependencies:** Task 1.3

**INPUT:** Knowledge schema design
**OUTPUT:**
- `knowledge-service/` folder structure
- Prisma schema with Collection, Document, DocumentChunk
- pgvector extension enabled

**VERIFY:**
- [ ] Migration applied
- [ ] Vector operations work

---

#### Task 2.2: Document Ingestion Pipeline
- **Agent:** `backend-specialist`
- **Priority:** P1
- **Dependencies:** Task 2.1

**INPUT:** Knowledge service
**OUTPUT:** Pipeline components:
- Parser (PDF, DOCX, MD, TXT)
- Chunker (H1/H2/H3 aware)
- Embedder (OpenAI compatible interface)

**VERIFY:**
- [ ] PDF uploaded → chunks created
- [ ] Embeddings stored correctly

---

#### Task 2.3: Collection ACL Service
- **Agent:** `backend-specialist`
- **Priority:** P1
- **Dependencies:** Task 2.1

**INPUT:** Knowledge schema
**OUTPUT:** ACL service:
- Set collection ACL
- Check user access to collection
- Inherit ACL to documents

**VERIFY:**
- [ ] ACL correctly restricts access
- [ ] Department/Group ACL works

---

#### Task 2.4: Knowledge API
- **Agent:** `backend-specialist`
- **Skills:** `api-patterns`
- **Priority:** P1
- **Dependencies:** Task 2.2, 2.3

**INPUT:** Knowledge service components
**OUTPUT:** API endpoints:
- `POST /collections` - Create collection
- `PUT /collections/:id/acl` - Set ACL
- `POST /documents` - Upload document
- `PUT /documents/:id/approve` - Approve for AI
- `GET /documents` - List documents (filtered by ACL)

**VERIFY:**
- [ ] Document upload → ingestion pipeline
- [ ] ACL filtering works

---

### Phase 3: Spring AI Integration (Node.js ↔ Spring)

> ⚠️ **NOTE:** User đã có Spring AI backend. Phase này focus vào **integration**, không build AI service mới.

#### Task 3.1: Spring AI Client Setup
- **Agent:** `backend-specialist`
- **Priority:** P2
- **Dependencies:** Task 2.2

**INPUT:** Spring AI API endpoints documentation
**OUTPUT:**
- `packages/shared/src/clients/spring-ai.client.ts`
- HTTP client wrapper với retry, timeout, error handling
- Environment config cho Spring AI URL

```typescript
// packages/shared/src/clients/spring-ai.client.ts
export class SpringAIClient {
  constructor(private baseUrl: string, private apiKey?: string)
  
  // RAG Query với user permissions
  async askWithPermissions(request: {
    query: string;
    userId: string;
    permissions: UserPermissions;
    collectionIds?: string[];
  }): Promise<RAGResponse>
  
  // Document sync
  async syncDocument(doc: DocumentSyncRequest): Promise<void>
  
  // Health check
  async healthCheck(): Promise<boolean>
}
```

**VERIFY:**
- [ ] Can connect to Spring AI backend
- [ ] Health check works
- [ ] Error handling correct

---

#### Task 3.2: Permission Payload Builder
- **Agent:** `backend-specialist`
- **Priority:** P2 (CRITICAL)
- **Dependencies:** Task 3.1, Task 2.3

**INPUT:** RBAC + Knowledge ACL services
**OUTPUT:** Service that builds user permission payload for Spring AI:

```typescript
// knowledge-service/src/services/permission-builder.service.ts
export class PermissionBuilderService {
  async buildPermissionPayload(userId: string): Promise<{
    userId: string;
    roles: string[];
    departments: string[];
    groups: string[];
    accessibleCollections: string[];
    classification: string[]; // PUBLIC, INTERNAL, etc.
  }>
}
```

**VERIFY:**
- [ ] Correctly aggregates user permissions
- [ ] Includes all ACL dimensions (role, dept, group)
- [ ] Performance acceptable (<100ms)

---

#### Task 3.3: Chat AI Bridge
- **Agent:** `backend-specialist`
- **Priority:** P2
- **Dependencies:** Task 3.2

**INPUT:** Spring AI Client + Permission Builder
**OUTPUT:** Bridge service trong chat-service:

```typescript
// chat-service/src/services/ai-bridge.service.ts
export class AIBridgeService {
  async askAI(userId: string, query: string, channelId?: string): Promise<{
    answer: string;
    citations: Citation[];
    processingTime: number;
  }>
}
```

**VERIFY:**
- [ ] Chat message with `/ask` triggers AI
- [ ] Response includes citations
- [ ] Permissions enforced (user chỉ thấy tài liệu được phép)

---

#### Task 3.4: Document Sync với Spring AI
- **Agent:** `backend-specialist`
- **Priority:** P2
- **Dependencies:** Task 3.1, Task 2.2

**INPUT:** Knowledge service + Spring AI client
**OUTPUT:** Sync mechanism:
- Khi document approved → gọi Spring AI để index
- Khi document deleted → gọi Spring AI để remove
- Include ACL metadata trong sync payload

**VERIFY:**
- [ ] Document upload → Spring AI indexed
- [ ] Document delete → Spring AI removed
- [ ] ACL metadata synced correctly

---

### Phase 4: Audit Service

#### Task 4.1: Audit Service Setup
- **Agent:** `backend-specialist`
- **Priority:** P2
- **Dependencies:** Task 1.3

**INPUT:** Audit requirements
**OUTPUT:**
- `audit-service/` folder structure
- Audit log schema
- Event handlers for NATS

**VERIFY:**
- [ ] Audit events stored
- [ ] Queryable by time/user/action

---

#### Task 4.2: Admin Audit Logging
- **Agent:** `backend-specialist`
- **Priority:** P2
- **Dependencies:** Task 4.1

**INPUT:** Audit service
**OUTPUT:** Log these admin actions:
- User role changes
- DM read by admin
- Document ACL changes
- User suspension/deletion

**VERIFY:**
- [ ] All admin actions logged
- [ ] IP address captured
- [ ] Audit trail queryable

---

#### Task 4.3: Security Officer Dashboard API
- **Agent:** `backend-specialist`
- **Priority:** P3
- **Dependencies:** Task 4.2

**INPUT:** Audit service
**OUTPUT:** API for:
- Query audit logs (filter by user/action/date)
- Export logs (CSV/JSON)
- Alert on suspicious activity

**VERIFY:**
- [ ] Logs exportable
- [ ] Time range filter works

---

## 🔐 Permission Matrix (Reference)

| Resource | Action | Super Admin | Org Admin | Employee | Guest |
|----------|--------|-------------|-----------|----------|-------|
| chat.channel | read | ✅ | ✅ (org) | ✅ (member) | ✅ (invited) |
| chat.dm | read | ✅ | ✅ (org, audited) | ✅ (own) | ❌ |
| user | create | ✅ | ✅ | ❌ | ❌ |
| user | delete | ✅ | ✅ | ❌ | ❌ |
| knowledge | upload | ✅ | ❌ | ❌ | ❌ |
| knowledge | read | ✅ | ✅ (ACL) | ✅ (ACL) | ❌ |
| ai.ask | execute | ✅ | ✅ | ✅ | ❌ |
| audit | read | ✅ | ❌ | ❌ | ❌ |
| audit | export | ✅ | ❌ | ❌ | ❌ |

---

## ⚠️ Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| ACL filtering bypassed | Data leak | Integration tests + penetration testing |
| Token role not synced | Privilege escalation | Short token expiry + refresh |
| Vector DB performance | Slow AI | pgvector HNSW index + caching |
| Admin abuse DM read | Trust violation | Mandatory audit + notification |

---

## 🔁 Rollback Strategy

| Component | Rollback Method |
|-----------|-----------------|
| RBAC Schema | Prisma migrate down |
| Knowledge Service | Remove service, keep DB |
| AI Service | Disable AI endpoints, fallback to no-AI |
| Audit Service | Keep logging to file if DB fails |

---

## ✅ Phase X: Verification Checklist

### Build Verification
- [ ] All services compile: `npm run build`
- [ ] No TypeScript errors
- [ ] All tests pass

### Security Verification
- [ ] Permission middleware tested
- [ ] ACL bypass tests (should fail = secure)
- [ ] Token validation works
- [ ] Audit logs capture admin actions

### Integration Verification
- [ ] RBAC ↔ Auth service integration
- [ ] Knowledge ↔ Spring AI integration
- [ ] Node.js ↔ Spring AI HTTP communication
- [ ] All services communicate via NATS

### Performance Verification
- [ ] RAG query < 2s (with permission filtering)
- [ ] Document ingestion < 30s per PDF

---

## 📅 Estimated Timeline

| Phase | Duration | Parallel? |
|-------|----------|-----------|
| Phase 1: RBAC Core | 2-3 days | No |
| Phase 2: Knowledge Service | 3-4 days | After Phase 1 |
| Phase 3: Spring AI Integration | 2 days | After Phase 2 |
| Phase 4: Audit Service | 1-2 days | Parallel with Phase 2* |

**Total:** ~8-11 days for MVP (giảm vì đã có Spring AI)

---

## 🚀 Next Steps

1. **Review & Approve** this plan
2. Run `/create` hoặc bắt đầu implement từng task
3. Ưu tiên Phase 1 (RBAC) trước vì là nền tảng cho tất cả

> 🔴 **QUAN TRỌNG:** Permission-Aware RAG là tính năng cốt lõi. Nếu AI trả lời tài liệu user không được phép xem = **FAIL bảo mật nghiêm trọng**.

---

## 🔗 Spring AI Integration Notes (CONFIRMED)

### ✅ Các quyết định đã xác nhận

| Item | Decision |
|------|----------|
| **Spring AI URL** | `http://localhost:8080` |
| **API Contract** | Có đầy đủ |
| **Permission Filtering** | **Option B** - Spring AI xử lý, Node.js chỉ gửi permissions |
| **Document Indexing** | Có API |

### Architecture Flow

```
User (Chat) 
    ↓
Node.js (chat-service)
    ↓ Build permission payload (roles, dept, groups)
    ↓ HTTP POST to Spring AI
Spring AI (localhost:8080)
    ↓ Filter documents by permissions
    ↓ RAG retrieval + LLM
    ↓ Return answer + citations
Node.js
    ↓ Forward to user
```

### API Contract (Reference)

```
POST http://localhost:8080/api/rag/ask
Body: {
  query: string,
  userId: string,
  permissions: {
    roles: string[],
    departments: string[],
    groups: string[],
    accessibleCollections: string[]
  }
}
Response: {
  answer: string,
  citations: [...],
  processingTime: number
}

POST http://localhost:8080/api/documents/sync
Body: {
  documentId: string,
  content: string,
  metadata: {...},
  acl: {...}
}
```

### Environment Config

```env
# .env
SPRING_AI_BASE_URL=http://localhost:8080
SPRING_AI_TIMEOUT=30000
```

---

## ✅ PLAN FINALIZED

Plan đã sẵn sàng để implement. Chạy Phase 1 (RBAC Core) trước.

---

# 📦 FEATURE MODULES (PRD/Backlog Ready)

> Bộ chức năng đầy đủ cho Enterprise Chat + AI RAG, chia theo module.
> Mỗi module có: Features, User Stories, và Role Permission Matrix.

---

## Module 1: 💬 Messaging (Core Chat)

### Features

| ID | Feature | Description | Priority |
|----|---------|-------------|----------|
| MSG-01 | **1-1 Direct Message** | Chat riêng tư giữa 2 người | P0 |
| MSG-02 | **Group Chat** | Chat nhóm nhiều người | P0 |
| MSG-03 | **Channel Chat** | Kênh công khai/private của workspace | P0 |
| MSG-04 | **Rich Text Editor** | Bold, italic, code block, bullet list | P1 |
| MSG-05 | **Emoji & Reactions** | React tin nhắn bằng emoji | P1 |
| MSG-06 | **Mentions** | @user, @here, @channel | P0 |
| MSG-07 | **Threads** | Reply trong thread riêng | P1 |
| MSG-08 | **Message Edit/Delete** | Chỉnh sửa, xóa tin nhắn của mình | P0 |
| MSG-09 | **Pin Messages** | Ghim tin nhắn quan trọng | P2 |
| MSG-10 | **Forward Messages** | Chuyển tiếp tin nhắn | P2 |
| MSG-11 | **Scheduled Messages** | Hẹn giờ gửi tin nhắn | P3 |
| MSG-12 | **Read Receipts** | Đã xem / đang nhập | P1 |

### Role Permissions

| Feature | SuperAdmin | OrgAdmin | Security | WS Manager | Employee | Guest |
|---------|------------|----------|----------|------------|----------|-------|
| Send DM | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Read any DM | ✅ | ✅ (audited) | ❌ | ❌ | ❌ own | ❌ |
| Send in Channel | ✅ | ✅ | ✅ | ✅ | ✅ joined | ✅ invited |
| Pin Message | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| Delete Others' Msg | ✅ | ✅ | ❌ | ✅ workspace | ❌ | ❌ |

---

## Module 2: 📁 File & Media Management

### Features

| ID | Feature | Description | Priority |
|----|---------|-------------|----------|
| FILE-01 | **File Upload** | Upload file trong chat | P0 |
| FILE-02 | **Image Preview** | Xem ảnh inline | P0 |
| FILE-03 | **File Download** | Tải file về máy | P0 |
| FILE-04 | **File Search** | Tìm kiếm file theo tên/loại | P1 |
| FILE-05 | **File Classification** | Đánh dấu: Public/Internal/Confidential/Restricted | P1 |
| FILE-06 | **Storage Quota** | Giới hạn dung lượng theo user/org | P2 |
| FILE-07 | **Virus Scan** | Quét virus trước khi lưu | P1 |
| FILE-08 | **File Expiry** | Tự động xóa file sau X ngày | P2 |
| FILE-09 | **Audio/Video Player** | Phát media inline | P2 |
| FILE-10 | **Drag & Drop Upload** | Kéo thả file vào chat | P1 |

### Role Permissions

| Feature | SuperAdmin | OrgAdmin | Security | WS Manager | Employee | Guest |
|---------|------------|----------|----------|------------|----------|-------|
| Upload File | ✅ | ✅ | ✅ | ✅ | ✅ policy | ❌ |
| Download All | ✅ | ✅ | ✅ export | ✅ | ✅ ACL | ⚠️ unrestricted |
| Set Classification | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Configure Quota | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

---

## Module 3: 👥 User & Organization Management

### Features

| ID | Feature | Description | Priority |
|----|---------|-------------|----------|
| USER-01 | **User Registration** | Đăng ký tài khoản (invite/open) | P0 |
| USER-02 | **User Profile** | Avatar, display name, status | P0 |
| USER-03 | **User Status** | Online/Away/DND/Invisible | P1 |
| USER-04 | **Custom Status** | "In a meeting", "On vacation" | P2 |
| USER-05 | **Department Management** | Tạo/quản lý phòng ban | P1 |
| USER-06 | **User Groups** | Tạo nhóm user (dự án, team) | P1 |
| USER-07 | **User Invitation** | Invite user qua email | P0 |
| USER-08 | **User Suspension** | Tạm khóa tài khoản | P1 |
| USER-09 | **User Deletion** | Xóa hoàn toàn hoặc anonymize | P1 |
| USER-10 | **Guest Invitation** | Mời external guest vào channel | P1 |
| USER-11 | **Role Assignment** | Gán/thay đổi role | P0 |
| USER-12 | **Org Settings** | Logo, tên công ty, timezone | P2 |

### Role Permissions

| Feature | SuperAdmin | OrgAdmin | Security | WS Manager | Employee | Guest |
|---------|------------|----------|----------|------------|----------|-------|
| Create User | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Edit Own Profile | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit Others | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Suspend User | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Assign Role | ✅ | ✅ < own | ❌ | ❌ | ❌ | ❌ |
| Manage Dept | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Invite Guest | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |

---

## Module 4: 🏢 Workspace & Channel Management

### Features

| ID | Feature | Description | Priority |
|----|---------|-------------|----------|
| WS-01 | **Create Workspace** | Tạo workspace mới | P0 |
| WS-02 | **Workspace Settings** | Tên, icon, description | P1 |
| WS-03 | **Public Channel** | Ai cũng join được | P0 |
| WS-04 | **Private Channel** | Invite only | P0 |
| WS-05 | **Guest Channel** | Channel cho external guests | P1 |
| WS-06 | **Channel Archive** | Đóng băng channel (readonly) | P1 |
| WS-07 | **Channel Delete** | Xóa hoàn toàn channel | P2 |
| WS-08 | **Channel Categories** | Nhóm channels theo category | P2 |
| WS-09 | **Member Management** | Add/remove members từ channel | P0 |
| WS-10 | **Channel Permissions** | Ai được post, ai chỉ đọc | P1 |
| WS-11 | **Default Channels** | Tự động join khi new user | P2 |
| WS-12 | **Channel Discovery** | Browse và join public channels | P1 |

### Role Permissions

| Feature | SuperAdmin | OrgAdmin | Security | WS Manager | Employee | Guest |
|---------|------------|----------|----------|------------|----------|-------|
| Create Workspace | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Create Channel | ✅ | ✅ | ❌ | ✅ | ✅ allowed | ❌ |
| Archive Channel | ✅ | ✅ | ❌ | ✅ owned | ❌ | ❌ |
| Delete Channel | ✅ | ✅ | ❌ | ✅ owned | ❌ | ❌ |
| Manage Members | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| Join Public | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

---

## Module 5: 🔍 Search & Discovery

### Features

| ID | Feature | Description | Priority |
|----|---------|-------------|----------|
| SRCH-01 | **Message Search** | Tìm tin nhắn theo keyword | P0 |
| SRCH-02 | **User Search** | Tìm người trong org | P0 |
| SRCH-03 | **Channel Search** | Tìm kênh theo tên | P0 |
| SRCH-04 | **File Search** | Tìm file theo tên/loại | P1 |
| SRCH-05 | **Advanced Filters** | Từ:user, trong:channel, trước:date | P1 |
| SRCH-06 | **Search in Thread** | Tìm trong thread cụ thể | P2 |
| SRCH-07 | **Saved Searches** | Lưu search query thường dùng | P3 |
| SRCH-08 | **Recent Search** | Lịch sử tìm kiếm | P2 |

### Role Permissions

| Feature | SuperAdmin | OrgAdmin | Security | WS Manager | Employee | Guest |
|---------|------------|----------|----------|------------|----------|-------|
| Search Messages | ✅ all | ✅ org | ✅ audit | ✅ workspace | ✅ joined | ❌ |
| Search Users | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ limited |
| Search Files | ✅ | ✅ | ✅ | ✅ | ✅ ACL | ❌ |

---

## Module 6: 🤖 AI & RAG (Permission-Aware)

### Features

| ID | Feature | Description | Priority |
|----|---------|-------------|----------|
| AI-01 | **Ask AI in Chat** | Hỏi AI trong cuộc chat `/ask` | P0 |
| AI-02 | **Ask Knowledge Base** | Hỏi về tài liệu công ty | P0 |
| AI-03 | **AI Summarize Thread** | Tóm tắt thread dài | P1 |
| AI-04 | **AI Compose Reply** | Gợi ý soạn thảo câu trả lời | P1 |
| AI-05 | **Citation Display** | Hiển thị nguồn trích dẫn | P0 |
| AI-06 | **AI Chat History** | Lịch sử hỏi đáp với AI | P2 |
| AI-07 | **Feedback Rating** | Đánh giá câu trả lời AI (👍👎) | P2 |
| AI-08 | **Permission-Aware RAG** | AI chỉ trả lời tài liệu user được phép | P0 🔴 |
| AI-09 | **AI Model Selection** | Chọn model (GPT-4, Claude, etc.) | P3 |
| AI-10 | **AI Usage Quota** | Giới hạn số lượng query/ngày | P2 |

### Role Permissions

| Feature | SuperAdmin | OrgAdmin | Security | WS Manager | Employee | Guest |
|---------|------------|----------|----------|------------|----------|-------|
| Ask AI | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Ask Knowledge | ✅ all | ✅ ACL | ❌ | ✅ ACL | ✅ ACL | ❌ |
| AI Summarize | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Configure AI | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| View AI Usage | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

> 🔴 **CRITICAL:** AI-08 (Permission-Aware RAG) là tính năng bảo mật bắt buộc!

---

## Module 7: 📚 Knowledge Management

### Features

| ID | Feature | Description | Priority |
|----|---------|-------------|----------|
| KB-01 | **Create Collection** | Tạo bộ sưu tập tài liệu | P0 |
| KB-02 | **Upload Document** | Upload PDF, DOCX, MD, TXT | P0 |
| KB-03 | **Document Tagging** | Gán tag để phân loại | P1 |
| KB-04 | **Document Classification** | PUBLIC/INTERNAL/CONFIDENTIAL/RESTRICTED | P0 |
| KB-05 | **Collection ACL** | Gán quyền cho collection | P0 |
| KB-06 | **Document Approval** | Duyệt tài liệu trước khi AI sử dụng | P1 |
| KB-07 | **Google Drive Connector** | Sync từ GDrive | P2 |
| KB-08 | **SharePoint Connector** | Sync từ SharePoint | P3 |
| KB-09 | **Confluence Connector** | Sync từ Confluence | P3 |
| KB-10 | **Document Versioning** | Lưu lịch sử phiên bản | P2 |
| KB-11 | **Ingestion Status** | Xem trạng thái xử lý tài liệu | P1 |
| KB-12 | **Document Preview** | Xem tài liệu không cần download | P2 |

### Role Permissions

| Feature | SuperAdmin | OrgAdmin | Security | WS Manager | Employee | Guest |
|---------|------------|----------|----------|------------|----------|-------|
| Create Collection | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Upload Doc | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Set ACL | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Approve Doc | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Read Collection | ✅ | ✅ ACL | ❌ | ✅ ACL | ✅ ACL | ❌ |
| View Status | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

> **Note:** Phase 2 sẽ có thêm roles: Knowledge Admin, Knowledge Curator

---

## Module 8: 🔒 Security & Compliance

### Features

| ID | Feature | Description | Priority |
|----|---------|-------------|----------|
| SEC-01 | **Audit Logging** | Ghi nhận mọi hoạt động quan trọng | P0 |
| SEC-02 | **Admin Action Audit** | Log khi admin đọc DM | P0 🔴 |
| SEC-03 | **Login History** | Lịch sử đăng nhập | P1 |
| SEC-04 | **Session Management** | Xem/revoke sessions | P1 |
| SEC-05 | **2FA/MFA** | Xác thực 2 yếu tố | P1 |
| SEC-06 | **SSO Integration** | Google, Microsoft, Okta | P2 |
| SEC-07 | **IP Whitelist** | Giới hạn truy cập theo IP | P2 |
| SEC-08 | **Data Retention** | Cấu hình thời gian lưu trữ | P1 |
| SEC-09 | **Legal Hold** | Giữ dữ liệu phục vụ pháp lý | P2 |
| SEC-10 | **Data Export** | Export dữ liệu theo case | P1 |
| SEC-11 | **GDPR Compliance** | Right to be forgotten, data portability | P2 |
| SEC-12 | **Security Alerts** | Cảnh báo hoạt động bất thường | P2 |

### Role Permissions

| Feature | SuperAdmin | OrgAdmin | Security | WS Manager | Employee | Guest |
|---------|------------|----------|----------|------------|----------|-------|
| View Audit Logs | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Export Logs | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Configure 2FA | ✅ | ✅ | ❌ | ❌ | ✅ own | ❌ |
| Session Mgmt | ✅ | ✅ all | ❌ | ❌ | ✅ own | ❌ |
| Set Retention | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Legal Hold | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Data Export | ✅ | ❌ | ✅ case | ❌ | ❌ | ❌ |
| IP Whitelist | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## Module 9: 🔔 Notifications & Preferences

### Features

| ID | Feature | Description | Priority |
|----|---------|-------------|----------|
| NOTIF-01 | **Push Notifications** | Mobile/Desktop push | P0 |
| NOTIF-02 | **Email Notifications** | Digest email | P1 |
| NOTIF-03 | **Notification Preferences** | Chỉnh mức độ thông báo | P1 |
| NOTIF-04 | **Do Not Disturb** | Tắt thông báo tạm thời | P1 |
| NOTIF-05 | **Notification Schedule** | Chỉ nhận trong giờ làm việc | P2 |
| NOTIF-06 | **Channel Mute** | Tắt thông báo kênh cụ thể | P1 |
| NOTIF-07 | **Mention Alerts** | Ưu tiên thông báo khi được mention | P1 |
| NOTIF-08 | **Desktop Badge** | Hiện số tin chưa đọc | P1 |

### Role Permissions

| Feature | SuperAdmin | OrgAdmin | Security | WS Manager | Employee | Guest |
|---------|------------|----------|----------|------------|----------|-------|
| Configure Own | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Force Org Settings | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

---

## 📊 Feature Priority Summary

| Priority | Count | Focus |
|----------|-------|-------|
| **P0** | ~25 | Must Have - MVP |
| **P1** | ~30 | Should Have - v1.0 |
| **P2** | ~25 | Nice to Have - v1.5 |
| **P3** | ~10 | Future - v2.0 |

---

## 🏷️ User Story Template

Khi viết PRD/Backlog, sử dụng format:

```
As a [ROLE],
I want to [FEATURE],
So that [BENEFIT].

Acceptance Criteria:
- Given [context], when [action], then [expected result].
- Role Permissions: [list allowed roles]
- Audit: [yes/no]
```

**Example:**

```
As an Org Admin,
I want to read DMs between employees,
So that I can investigate policy violations.

Acceptance Criteria:
- Given I am logged in as Org Admin
- When I access DM read feature
- Then the action is logged to audit with my userId, IP, and timestamp
- Role Permissions: [SuperAdmin, OrgAdmin]
- Audit: ✅ YES (mandatory)
```
