import { PrismaClient } from './node_modules/.prisma/client-auth/index.js';
const prisma = new PrismaClient();
async function main() {
    try {
        const res = await prisma.$queryRawUnsafe(`SELECT schema_name FROM information_schema.schemata`);
        console.log(res);
        const tables = await prisma.$queryRawUnsafe(`SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('auth', 'userorg', 'rbac', 'public')`);
        console.log(tables);
    } catch (e) {
        console.error(e.message);
    } finally {
        await prisma.$disconnect();
    }
}
main();
