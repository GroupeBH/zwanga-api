import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { SupportTicket } from '../support/entities/support-ticket.entity';

@Entity('partner_organizations')
export class PartnerOrganization {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ length: 160 }) displayName: string;
  @Column({ type: 'varchar', length: 200, nullable: true }) legalName: string | null;
  @Column({ length: 30 }) legalType: string;
  @Column({ length: 30, default: 'PROSPECT' }) status: string;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) partnerTypes: { type: string; status: string }[];
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('partner_members')
@Index('UQ_partner_member_org_user', ['organizationId', 'userId'], { unique: true })
@Index('IDX_partner_member_user', ['userId'])
export class PartnerMember {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) organizationId: string;
  @ManyToOne(() => PartnerOrganization, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'organizationId' }) organization: PartnerOrganization;
  @Column({ type: 'uuid' }) userId: string;
  @ManyToOne(() => User, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'userId' }) user: User;
  @Column({ length: 30 }) role: string;
  @Column({ length: 20, default: 'ACTIVE' }) status: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('partner_field_leads')
@Index('UQ_partner_field_lead_phone', ['organizationId', 'phone'], { unique: true })
@Index('IDX_partner_field_lead_agent_created', ['agentId', 'createdAt'])
export class PartnerFieldLead {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) organizationId: string;
  @ManyToOne(() => PartnerOrganization, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'organizationId' }) organization: PartnerOrganization;
  @Column({ type: 'uuid' }) agentId: string;
  @ManyToOne(() => User, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'agentId' }) agent: User;
  @Column({ length: 80 }) firstName: string;
  @Column({ length: 80 }) lastName: string;
  @Column({ length: 15 }) phone: string;
  @Column({ length: 100 }) city: string;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('partner_field_targets')
@Index('UQ_partner_field_target', ['organizationId', 'agentId', 'period'], { unique: true })
@Index('IDX_partner_field_target_agent', ['agentId'])
export class PartnerFieldTarget {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) organizationId: string;
  @ManyToOne(() => PartnerOrganization, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'organizationId' }) organization: PartnerOrganization;
  @Column({ type: 'uuid' }) agentId: string;
  @ManyToOne(() => User, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'agentId' }) agent: User;
  @Column({ length: 7 }) period: string;
  @Column({ type: 'integer' }) goal: number;
}

@Entity('partner_field_tickets')
@Index('UQ_partner_field_ticket_support', ['supportTicketId'], { unique: true })
@Index('IDX_partner_field_ticket_org_author', ['organizationId', 'authorId'])
export class PartnerFieldTicket {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) organizationId: string;
  @ManyToOne(() => PartnerOrganization, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'organizationId' }) organization: PartnerOrganization;
  @Column({ type: 'uuid' }) authorId: string;
  @ManyToOne(() => User, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'authorId' }) author: User;
  @Column({ type: 'uuid' }) supportTicketId: string;
  @ManyToOne(() => SupportTicket, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'supportTicketId' }) supportTicket: SupportTicket;
  @Column({ type: 'uuid', nullable: true }) leadId: string | null;
  @ManyToOne(() => PartnerFieldLead, { nullable: true, onDelete: 'SET NULL' }) @JoinColumn({ name: 'leadId' }) lead: PartnerFieldLead | null;
  @Column({ length: 20 }) category: string;
  @Column({ type: 'text' }) message: string;
  @CreateDateColumn() createdAt: Date;
}
