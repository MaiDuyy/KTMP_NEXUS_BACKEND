// services/group-service/src/services/channel-category.service.ts
// WS-08: Channel Categories management

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

// Types
interface CreateCategoryInput {
  name: string;
  position?: number;
}

interface UpdateCategoryInput {
  name?: string;
  position?: number;
}

export class ChannelCategoryService {
  /**
   * Create channel category
   */
  async createCategory(workspaceId: string, data: CreateCategoryInput, userId: string) {
    const { name, position } = data;

    if (!name || name.trim().length < 1) {
      throw new Error('Tên category là bắt buộc!');
    }

    // Check workspace membership and permission
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId },
      },
    });

    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) {
      throw new Error('Bạn không có quyền tạo category!');
    }

    // Get max position if not provided
    let categoryPosition = position;
    if (categoryPosition === undefined) {
      const lastCategory = await prisma.channelCategory.findFirst({
        where: { workspaceId },
        orderBy: { position: 'desc' },
      });
      categoryPosition = (lastCategory?.position ?? -1) + 1;
    }

    // Check name uniqueness
    const existing = await prisma.channelCategory.findUnique({
      where: {
        workspaceId_name: { workspaceId, name: name.trim() },
      },
    });

    if (existing) {
      throw new Error('Tên category đã tồn tại!');
    }

    const category = await prisma.channelCategory.create({
      data: {
        workspaceId,
        name: name.trim(),
        position: categoryPosition,
      },
    });

    logger.info({ categoryId: category.id, workspaceId }, 'Category created');

    return category;
  }

  /**
   * List categories in workspace
   */
  async listCategories(workspaceId: string, userId: string) {
    // Check workspace membership
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId },
      },
    });

    if (!membership) {
      throw new Error('Bạn không phải thành viên của workspace này!');
    }

    const categories = await prisma.channelCategory.findMany({
      where: { workspaceId },
      include: {
        channels: {
          where: { isArchived: false },
          select: {
            id: true,
            name: true,
            type: true,
          },
          orderBy: { position: 'asc' },
        },
        _count: {
          select: { channels: true },
        },
      },
      orderBy: { position: 'asc' },
    });

    return categories;
  }

  /**
   * Update category
   */
  async updateCategory(id: string, data: UpdateCategoryInput, userId: string) {
    const category = await prisma.channelCategory.findUnique({
      where: { id },
      include: { workspace: true },
    });

    if (!category) {
      throw new Error('Không tìm thấy category!');
    }

    // Check permission
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: category.workspaceId, userId },
      },
    });

    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) {
      throw new Error('Bạn không có quyền chỉnh sửa category!');
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.position !== undefined) updateData.position = data.position;

    const updated = await prisma.channelCategory.update({
      where: { id },
      data: updateData,
    });

    logger.info({ categoryId: id }, 'Category updated');

    return updated;
  }

  /**
   * Delete category
   */
  async deleteCategory(id: string, userId: string) {
    const category = await prisma.channelCategory.findUnique({
      where: { id },
      include: { channels: true },
    });

    if (!category) {
      throw new Error('Không tìm thấy category!');
    }

    // Check permission
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: category.workspaceId, userId },
      },
    });

    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) {
      throw new Error('Bạn không có quyền xóa category!');
    }

    // Remove category from channels (don't delete channels, just unassign)
    await prisma.channel.updateMany({
      where: { categoryId: id },
      data: { categoryId: null },
    });

    await prisma.channelCategory.delete({
      where: { id },
    });

    logger.info({ categoryId: id }, 'Category deleted');

    return { deleted: true };
  }

  /**
   * Reorder categories
   */
  async reorderCategories(workspaceId: string, categoryIds: string[], userId: string) {
    // Check permission
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId },
      },
    });

    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) {
      throw new Error('Bạn không có quyền sắp xếp category!');
    }

    // Update positions
    await Promise.all(
      categoryIds.map((id, index) =>
        prisma.channelCategory.update({
          where: { id },
          data: { position: index },
        })
      )
    );

    logger.info({ workspaceId, count: categoryIds.length }, 'Categories reordered');

    return { reordered: true };
  }

  /**
   * Reorder channels within a category
   */
  async reorderChannelsInCategory(categoryId: string, channelIds: string[], userId: string) {
    const category = await prisma.channelCategory.findUnique({
      where: { id: categoryId },
    });

    if (!category) {
      throw new Error('Không tìm thấy category!');
    }

    // Check permission
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: category.workspaceId, userId },
      },
    });

    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) {
      throw new Error('Bạn không có quyền sắp xếp channels!');
    }

    // Update positions
    await Promise.all(
      channelIds.map((id, index) =>
        prisma.channel.update({
          where: { id },
          data: { position: index, categoryId },
        })
      )
    );

    logger.info({ categoryId, count: channelIds.length }, 'Channels reordered');

    return { reordered: true };
  }

  /**
   * Move channel to category
   */
  async moveChannelToCategory(channelId: string, categoryId: string | null, userId: string) {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
    });

    if (!channel) {
      throw new Error('Không tìm thấy channel!');
    }

    // Check permission
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: channel.workspaceId, userId },
      },
    });

    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) {
      throw new Error('Bạn không có quyền di chuyển channel!');
    }

    // Validate category belongs to same workspace
    if (categoryId) {
      const category = await prisma.channelCategory.findUnique({
        where: { id: categoryId },
      });

      if (!category || category.workspaceId !== channel.workspaceId) {
        throw new Error('Category không hợp lệ!');
      }
    }

    const updated = await prisma.channel.update({
      where: { id: channelId },
      data: { categoryId },
    });

    logger.info({ channelId, categoryId }, 'Channel moved to category');

    return updated;
  }
}

export const channelCategoryService = new ChannelCategoryService();
