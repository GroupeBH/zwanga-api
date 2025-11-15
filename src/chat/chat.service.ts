import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message } from './entities/message.entity';
import { Booking } from '../bookings/entities/booking.entity';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectRepository(Message)
    private messageRepository: Repository<Message>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
  ) {}

  async createMessage(
    bookingId: string,
    senderId: string,
    content: string,
  ): Promise<Message> {
    this.logger.log(`Creating message for booking ${bookingId} by user ${senderId}`);
    
    // Verify booking exists and user is part of it
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'passenger'],
    });

    if (!booking) {
      this.logger.warn(`Message creation failed: Booking ${bookingId} not found`);
      throw new Error('Booking not found');
    }

    if (
      booking.passengerId !== senderId &&
      booking.trip.driverId !== senderId
    ) {
      this.logger.warn(`Message creation failed: User ${senderId} unauthorized for booking ${bookingId}`);
      throw new Error('Unauthorized to send message in this booking');
    }

    const message = this.messageRepository.create({
      bookingId,
      senderId,
      content,
    });

    const savedMessage = await this.messageRepository.save(message);
    
    this.logger.log(`Message created successfully: ${savedMessage.id} for booking ${bookingId}`);
    return savedMessage;
  }

  async getMessages(bookingId: string, userId: string): Promise<Message[]> {
    this.logger.debug(`Fetching messages for booking ${bookingId} by user ${userId}`);
    
    // Verify user is part of the booking
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'passenger'],
    });

    if (!booking) {
      this.logger.warn(`Get messages failed: Booking ${bookingId} not found`);
      throw new Error('Booking not found');
    }

    if (booking.passengerId !== userId && booking.trip.driverId !== userId) {
      this.logger.warn(`Get messages failed: User ${userId} unauthorized for booking ${bookingId}`);
      throw new Error('Unauthorized to view messages');
    }

    const messages = await this.messageRepository.find({
      where: { bookingId },
      relations: ['sender'],
      order: { createdAt: 'ASC' },
    });

    this.logger.debug(`Retrieved ${messages.length} messages for booking ${bookingId}`);
    return messages;
  }

  async markAsRead(messageId: string, userId: string): Promise<void> {
    this.logger.debug(`Marking message ${messageId} as read by user ${userId}`);
    
    const message = await this.messageRepository.findOne({
      where: { id: messageId },
      relations: ['booking', 'booking.trip'],
    });

    if (!message) {
      this.logger.warn(`Mark as read failed: Message ${messageId} not found`);
      throw new Error('Message not found');
    }

    // Only mark as read if user is not the sender
    if (message.senderId !== userId && !message.isRead) {
      message.isRead = true;
      message.readAt = new Date();
      await this.messageRepository.save(message);
      this.logger.debug(`Message ${messageId} marked as read`);
    } else {
      this.logger.debug(`Message ${messageId} already read or user is sender`);
    }
  }
}

