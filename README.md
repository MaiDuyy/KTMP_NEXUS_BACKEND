# Back End NEXUS

Tài liệu này hướng dẫn chi tiết cách thiết lập môi trường phát triển cho dự án NEXUS (Cấu trúc thư mục)
## 1\. Khởi tạo Dự án & Cài đặt Dependencies
### Khởi tạo project

```bash
npm init -y
```

### Cài đặt Development Dependencies (TypeScript, TSX, Types)

```bash
npm install typescript tsx @types/node --save-dev
npm install express
npm install typescript @types/node @types/express ts-node --save-dev
```

### Nếu đã package.json đã có dependencies thì chạy lệnh dưới để cài đặt thư viện

```bash
npm i
```

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
## 3\. Khởi chạy app.ts 

```bash
npm run dev
```