import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message } from './entities/message.entity';
import { Booking } from '../bookings/entities/booking.entity';

@Injectable()
export class ChatService {
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
    // Verify booking exists and user is part of it
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'passenger'],
    });

    if (!booking) {
      throw new Error('Booking not found');
    }

    if (
      booking.passengerId !== senderId &&
      booking.trip.driverId !== senderId
    ) {
      throw new Error('Unauthorized to send message in this booking');
    }

    const message = this.messageRepository.create({
      bookingId,
      senderId,
      content,
    });

    return await this.messageRepository.save(message);
  }

  async getMessages(bookingId: string, userId: string): Promise<Message[]> {
    // Verify user is part of the booking
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'passenger'],
    });

    if (!booking) {
      throw new Error('Booking not found');
    }

    if (booking.passengerId !== userId && booking.trip.driverId !== userId) {
      throw new Error('Unauthorized to view messages');
    }

    return this.messageRepository.find({
      where: { bookingId },
      relations: ['sender'],
      order: { createdAt: 'ASC' },
    });
  }

  async markAsRead(messageId: string, userId: string): Promise<void> {
    const message = await this.messageRepository.findOne({
      where: { id: messageId },
      relations: ['booking', 'booking.trip'],
    });

    if (!message) {
      throw new Error('Message not found');
    }

    // Only mark as read if user is not the sender
    if (message.senderId !== userId && !message.isRead) {
      message.isRead = true;
      message.readAt = new Date();
      await this.messageRepository.save(message);
    }
  }
}

