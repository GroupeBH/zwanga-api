import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { isBackOfficeRole } from '../users/user-role.policy';
import { UserRole } from '../users/entities/user.entity';
import { StoreAccessGrant } from './store-operations.entities';
import { StoreConfig } from './store.config';

export const STORE_PERMISSIONS = [
  'store.analytics.read',
  'store.reviews.read',
  'store.reviews.draft',
  'store.reviews.reply',
  'store.reviews.approve',
  'store.versions.read',
  'store.vitals.read',
  'store.integrations.manage',
  'store.sync.execute',
  'store.sync.read',
  'store.reports.export',
  'store.audit.read',
  'store.alerts.read',
  'store.alerts.manage',
  'store.access.manage',
] as const;
export type StorePermissionName = (typeof STORE_PERMISSIONS)[number];
const READ_ONLY = STORE_PERMISSIONS.filter(
  (p) => p.endsWith('.read') || p === 'store.reports.export',
);
export const STORE_PROFILES: Record<string, readonly StorePermissionName[]> = {
  reader: READ_ONLY,
  technical: [
    ...READ_ONLY,
    'store.integrations.manage',
    'store.sync.execute',
    'store.alerts.manage',
  ],
  product: [
    'store.analytics.read',
    'store.versions.read',
    'store.vitals.read',
    'store.reports.export',
    'store.alerts.read',
  ],
  marketing: [
    'store.analytics.read',
    'store.reviews.read',
    'store.reviews.draft',
    'store.reports.export',
    'store.alerts.read',
  ],
  support: ['store.reviews.read', 'store.reviews.draft'],
  validator: [
    'store.reviews.read',
    'store.reviews.approve',
    'store.reviews.reply',
    'store.audit.read',
    'store.sync.read',
  ],
};
export const storePermissions = (
  role: unknown,
): readonly StorePermissionName[] =>
  role === UserRole.SUPER_ADMIN
    ? STORE_PERMISSIONS
    : role === UserRole.ADMIN
      ? READ_ONLY
      : [];
@Injectable()
export class StoreAccess {
  constructor(
    private readonly db: DataSource,
    private readonly config: StoreConfig,
  ) {}
  async permissions(
    userId: string,
    role: unknown,
  ): Promise<readonly StorePermissionName[]> {
    if (!isBackOfficeRole(role)) return [];
    if (role === UserRole.SUPER_ADMIN || !this.config.enabled)
      return storePermissions(role);
    const grant = await this.db
      .getRepository(StoreAccessGrant)
      .findOneBy({ userId });
    return grant
      ? grant.permissions.filter((p): p is StorePermissionName =>
          STORE_PERMISSIONS.includes(p as StorePermissionName),
        )
      : storePermissions(role);
  }
}
@Injectable()
export class StorePermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: StoreAccess,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const permission = this.reflector.getAllAndOverride<
      StorePermissionName | 'store.access' | 'store.records.read'
    >('store.permission', [context.getHandler(), context.getClass()]);
    const actor = req.user;
    if (!actor || actor.passwordChangeRequired || !permission)
      throw new ForbiddenException('Permission Store Management requise.');
    const permissions = await this.access.permissions(actor.userId, actor.role);
    const kinds: Record<string, StorePermissionName> = {
      app: 'store.versions.read',
      release: 'store.versions.read',
      build: 'store.versions.read',
      review: 'store.reviews.read',
      report: 'store.analytics.read',
      performance: 'store.vitals.read',
    };
    const allowed =
      permission === 'store.access'
        ? permissions.length > 0
        : permission === 'store.records.read'
          ? req.query.kind
            ? permissions.includes(kinds[req.query.kind])
            : Object.values(kinds).every((p) => permissions.includes(p))
          : permissions.includes(permission);
    if (!allowed)
      throw new ForbiddenException('Permission Store Management requise.');
    req.storePermissions = permissions;
    return true;
  }
}
export const StorePermission = (
  permission: StorePermissionName | 'store.access' | 'store.records.read',
) =>
  applyDecorators(
    SetMetadata('store.permission', permission),
    UseGuards(StorePermissionsGuard),
  );
