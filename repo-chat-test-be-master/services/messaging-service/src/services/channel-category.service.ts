// services/messaging-service/src/services/channel-category.service.ts
// Channel Categories — migrated from group-service (import paths updated)

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

interface CreateCategoryInput { name: string; position?: number; }
interface UpdateCategoryInput { name?: string; position?: number; }

export class ChannelCategoryService {
  async createCategory(workspaceId: string, data: CreateCategoryInput, userId: string) {
    const { name, position } = data;
    if (!name || name.trim().length < 1) throw new Error('Tên category là bắt buộc!');

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) throw new Error('Bạn không có quyền tạo category!');

    let categoryPosition = position;
    if (categoryPosition === undefined) {
      const lastCategory = await prisma.channelCategory.findFirst({ where: { workspaceId }, orderBy: { position: 'desc' } });
      categoryPosition = (lastCategory?.position ?? -1) + 1;
    }

    const existing = await prisma.channelCategory.findUnique({
      where: { workspaceId_name: { workspaceId, name: name.trim() } },
    });
    if (existing) throw new Error('Tên category đã tồn tại!');

    const category = await prisma.channelCategory.create({
      data: { workspaceId, name: name.trim(), position: categoryPosition },
    });
    logger.info({ categoryId: category.id, workspaceId }, 'Category created');
    return category;
  }

  async listCategories(workspaceId: string, userId: string) {
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!membership) throw new Error('Bạn không phải thành viên của workspace này!');

    return prisma.channelCategory.findMany({
      where: { workspaceId },
      include: {
        channels: { where: { isArchived: false }, select: { id: true, name: true, type: true }, orderBy: { position: 'asc' } },
        _count: { select: { channels: true } },
      },
      orderBy: { position: 'asc' },
    });
  }

  async updateCategory(id: string, data: UpdateCategoryInput, userId: string) {
    const category = await prisma.channelCategory.findUnique({ where: { id }, include: { workspace: true } });
    if (!category) throw new Error('Không tìm thấy category!');

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: category.workspaceId, userId } },
    });
    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) throw new Error('Bạn không có quyền chỉnh sửa category!');

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.position !== undefined) updateData.position = data.position;

    const updated = await prisma.channelCategory.update({ where: { id }, data: updateData });
    logger.info({ categoryId: id }, 'Category updated');
    return updated;
  }

  async deleteCategory(id: string, userId: string) {
    const category = await prisma.channelCategory.findUnique({ where: { id }, include: { channels: true } });
    if (!category) throw new Error('Không tìm thấy category!');

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: category.workspaceId, userId } },
    });
    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) throw new Error('Bạn không có quyền xóa category!');

    await prisma.channel.updateMany({ where: { categoryId: id }, data: { categoryId: null } });
    await prisma.channelCategory.delete({ where: { id } });
    logger.info({ categoryId: id }, 'Category deleted');
    return { deleted: true };
  }

  async reorderCategories(workspaceId: string, categoryIds: string[], userId: string) {
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) throw new Error('Bạn không có quyền sắp xếp category!');

    await Promise.all(categoryIds.map((id, index) => prisma.channelCategory.update({ where: { id }, data: { position: index } })));
    logger.info({ workspaceId, count: categoryIds.length }, 'Categories reordered');
    return { reordered: true };
  }

  async reorderChannelsInCategory(categoryId: string, channelIds: string[], userId: string) {
    const category = await prisma.channelCategory.findUnique({ where: { id: categoryId } });
    if (!category) throw new Error('Không tìm thấy category!');

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: category.workspaceId, userId } },
    });
    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) throw new Error('Bạn không có quyền sắp xếp channels!');

    await Promise.all(channelIds.map((id, index) => prisma.channel.update({ where: { id }, data: { position: index, categoryId } })));
    logger.info({ categoryId, count: channelIds.length }, 'Channels reordered');
    return { reordered: true };
  }

  async moveChannelToCategory(channelId: string, categoryId: string | null, userId: string) {
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new Error('Không tìm thấy channel!');

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId } },
    });
    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) throw new Error('Bạn không có quyền di chuyển channel!');

    if (categoryId) {
      const category = await prisma.channelCategory.findUnique({ where: { id: categoryId } });
      if (!category || category.workspaceId !== channel.workspaceId) throw new Error('Category không hợp lệ!');
    }

    const updated = await prisma.channel.update({ where: { id: channelId }, data: { categoryId } });
    logger.info({ channelId, categoryId }, 'Channel moved to category');
    return updated;
  }
}

export const channelCategoryService = new ChannelCategoryService();
