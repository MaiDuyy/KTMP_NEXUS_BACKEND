
# Chat Server Backend - Hướng dẫn Khởi tạo & Cài đặt

Tài liệu này hướng dẫn chi tiết cách thiết lập môi trường phát triển cho dự án Chat Server sử dụng **Node.js**, **TypeScript**, **Prisma** (với MariaDB/MySQL).

## 1\. Khởi tạo Dự án & Cài đặt Dependencies

Chạy lần lượt các lệnh sau trong terminal để khởi tạo `package.json` và cài đặt các thư viện cần thiết:

### Khởi tạo project

```bash
npm init -y
```

### Cài đặt Development Dependencies (TypeScript, TSX, Types)

```bash
npm install typescript tsx @types/node --save-dev
```

### Cài đặt Runtime Dependencies (Prisma, Dotenv, Driver MariaDB)

```bash
npm install prisma @types/node --save-dev
npm install @prisma/client @prisma/adapter-mariadb dotenv
```

-----

## 2\. Cấu hình TypeScript (`tsconfig.json`)

Chạy lệnh khởi tạo (hoặc tạo file thủ công):

```bash
npx tsc --init
```

Cập nhật nội dung file `tsconfig.json` như sau để phù hợp với cấu trúc dự án (Source nằm trong `./src`, Output ra `./dist`):

```json
{
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "module": "ESNext",
    "moduleResolution": "node",
    "target": "ES2023",
    "strict": true,
    "esModuleInterop": true,
    "ignoreDeprecations": "6.0",
    "types": ["node"],
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "jsx": "react-jsx",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noUncheckedSideEffectImports": true,
    "moduleDetection": "force",
    "skipLibCheck": true
  },
  "include": ["./src"],
  "exclude": ["dist", "node_modules"]
}
```

-----

## 3\. Cấu hình Biến môi trường (`.env`)

Tạo file `.env` tại thư mục gốc của dự án và điền thông tin kết nối cơ sở dữ liệu:

```env
# Database Credentials
DATABASE_HOST="3306"
DATABASE_USER="root"
DATABASE_PASSWORD="root"
DATABASE_NAME="chat-server"

# Prisma Connection String
# Định dạng: mysql://USER:PASSWORD@HOST:PORT/DATABASE
DATABASE_URL="mysql://root:root@localhost:3306/chat-server"
```

> **Lưu ý:** Đảm bảo bạn đã cài đặt và đang chạy MySQL hoặc MariaDB ở port `3306`.

-----

## 4\. Thiết lập Prisma (Database ORM)

### Khởi tạo Prisma

```bash
mkdir src && cd src 
```

Lệnh này sẽ tạo thư mục cấu hình Prisma (theo đường dẫn tuỳ chỉnh bạn yêu cầu):

```bash
npx prisma init --datasource-provider postgresql --output ../generated/prisma
```

### Định nghĩa Schema (Ví dụ)

Mở file `schema.prisma` (vừa được tạo) và định nghĩa các model của bạn.

### Migrate Database

Đồng bộ schema của bạn vào database thực tế:

```bash
npx prisma migrate dev --name init
```

### Generate Prisma Client

Tạo các type TypeScript dựa trên schema:

```bash
npx prisma generate
```


### Rest Database with prisma 

Chạy lại database sau khi update field nào đó

```bash
npx prisma generate reset 
```

-----

## 5\. Chạy Dự án (Development)

Tạo file `src/index.ts` (hoặc file entry point chính của bạn) và chạy lệnh sau để bắt đầu server:

```bash
# Chạy trực tiếp file TypeScript (không cần build)
npx tsx src/index.ts
```

Hoặc thêm vào `package.json` scripts:

```json
"scripts": {
  "dev": "tsx src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js"
}
```

Sau đó chạy: `npm run dev`

-----

### Bạn có muốn tôi giúp bạn tạo luôn file mẫu `src/index.ts` để kiểm tra kết nối Database không?


docker-compose up -d postgres redis nats

docker-compose up -d postgres redis nats auth-service userorg-service rbac-service notification-service

docker compose --env-file .env.docker up -d postgres redis nats identity-service messaging-service file-service notification-service api-gateway ws-gateway


docker compose build redis nats identity-service messaging-service file-service notification-service api-gateway ws-gateway

docker exec -it ott-postgres psql -U ott_user -d ott_chat

-- xem có schema auth chưa
\dn

-- xem bảng trong schema auth
\dt auth.*
