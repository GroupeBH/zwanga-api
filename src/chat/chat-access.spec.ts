import { ForbiddenException } from '@nestjs/common';
import { ChatService } from './chat.service';
import { Booking } from '../bookings/entities/booking.entity';
import { Conversation, ConversationType } from './entities/conversation.entity';
import { Message } from './entities/message.entity';

const passenger = '00000000-0000-4000-8000-000000000001';
const driver = '00000000-0000-4000-8000-000000000002';
const stranger = '00000000-0000-4000-8000-000000000003';
const bookingId = '00000000-0000-4000-8000-000000000004';
const conversationId = '00000000-0000-4000-8000-000000000005';

function fixture() {
  const booking = Object.assign(new Booking(), {
    id: bookingId,
    passengerId: passenger,
    trip: { driverId: driver },
  });
  const conversation = Object.assign(new Conversation(), {
    id: conversationId,
    bookingId,
    type: ConversationType.BOOKING,
    // Simulate an old unauthorized membership: it must no longer grant access.
    participants: [passenger, driver, stranger].map((userId) => ({ userId })),
  });
  const query = {
    innerJoin: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  const conversations = {
    findOne: jest.fn().mockResolvedValue(conversation),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(query),
  };
  const messages = {
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(),
  };
  const participantRows = [passenger, driver, stranger].map((userId) => ({
    userId,
    user: { fcmToken: `token-${userId}` },
  }));
  const participants = {
    find: jest.fn().mockResolvedValue(participantRows),
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const bookings = { findOne: jest.fn().mockResolvedValue(booking) };
  const users = {
    find: jest.fn().mockResolvedValue([{ id: passenger }, { id: driver }]),
  };
  const notifications = {
    sendNotification: jest.fn(),
    sendToMultiple: jest.fn(),
  };
  const service = new ChatService(
    ...([
      messages,
      conversations,
      participants,
      bookings,
      users,
      notifications,
      {},
    ] as unknown as ConstructorParameters<typeof ChatService>),
  );
  return {
    service,
    conversation,
    conversations,
    messages,
    participants,
    bookings,
    notifications,
    query,
  };
}

describe('Booking conversation access', () => {
  it.each([passenger, driver])(
    'permits the actual booking party %s',
    async (userId) => {
      const { service } = fixture();
      await expect(
        service.ensureUserCanAccessBookingChat(bookingId, userId),
      ).resolves.toMatchObject({ id: bookingId });
      await expect(
        service.getConversationMessages(conversationId, userId),
      ).resolves.toEqual([]);
    },
  );

  it.each([stranger, ''])(
    'rejects outsider or missing identity %s',
    async (userId) => {
      const { service } = fixture();
      await expect(
        service.ensureUserCanAccessBookingChat(bookingId, userId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('refuses to look up an absent booking ID or identity', async () => {
    const { service, bookings } = fixture();
    await expect(
      service.ensureUserCanAccessBookingChat('', passenger),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.ensureUserCanAccessBookingChat(bookingId, ''),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(bookings.findOne).not.toHaveBeenCalled();
  });

  it('rejects a nonexistent booking with the same access error', async () => {
    const { service, bookings } = fixture();
    bookings.findOne.mockResolvedValue(null);
    await expect(
      service.ensureUserCanAccessBookingChat(bookingId, stranger),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks self-enrollment through REST before creating or changing any conversation', async () => {
    const { service, conversations, participants } = fixture();
    await expect(
      service.createConversation(stranger, {
        bookingId,
        participantIds: [stranger],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(conversations.findOne).not.toHaveBeenCalled();
    expect(conversations.create).not.toHaveBeenCalled();
    expect(participants.save).not.toHaveBeenCalled();
  });

  it.each([passenger, driver])(
    'allows a booking party to open the REST conversation: %s',
    async (userId) => {
      const { service } = fixture();
      await expect(
        service.createConversation(userId, {
          bookingId,
          participantIds: [passenger, driver],
        }),
      ).resolves.toMatchObject({ id: conversationId, bookingId });
    },
  );

  it('does not allow a legitimate participant to invite an outsider to a booking conversation', async () => {
    const { service, participants } = fixture();
    await expect(
      service.createConversation(passenger, {
        bookingId,
        participantIds: [stranger],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.addParticipants(conversationId, passenger, [stranger]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(participants.save).not.toHaveBeenCalled();
  });

  it('ignores a stale membership for all message reads, sends and participant changes', async () => {
    const { service, messages, participants } = fixture();
    await expect(
      service.getConversation(stranger, conversationId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.getConversationMessages(conversationId, stranger),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.getConversationMessagePage(conversationId, stranger, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.sendConversationMessage(conversationId, stranger, 'Hello'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.getMessages(bookingId, stranger),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.createMessage(bookingId, stranger, 'Hello'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.addParticipants(conversationId, stranger, [stranger]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.removeParticipant(conversationId, stranger, passenger),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.markConversationRead(conversationId, stranger),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(messages.find).not.toHaveBeenCalled();
    expect(messages.findOne).not.toHaveBeenCalled();
    expect(messages.create).not.toHaveBeenCalled();
    expect(messages.createQueryBuilder).not.toHaveBeenCalled();
    expect(participants.update).not.toHaveBeenCalled();
    expect(participants.remove).not.toHaveBeenCalled();
  });

  it('filters booking ownership in SQL before computing pagination and counts', async () => {
    const { service, query } = fixture();
    await service.listConversations(passenger, { page: 2, limit: 20 });
    expect(query.leftJoin).toHaveBeenCalledWith(
      Booking,
      'conversationBooking',
      'CAST(conversationBooking.id AS text) = conversation.bookingId',
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      '(conversation.bookingId IS NULL OR conversationBooking.passengerId = :viewerId OR conversationTrip.driverId = :viewerId)',
      { viewerId: passenger },
    );
    expect(query.skip).toHaveBeenCalledWith(20);
    expect(query.take).toHaveBeenCalledWith(20);
    expect(query.getManyAndCount).toHaveBeenCalled();
  });

  it('blocks modification of messages previously injected by an unauthorized participant', async () => {
    const { service, messages } = fixture();
    messages.findOne.mockResolvedValue({
      id: 'message',
      conversationId,
      senderId: stranger,
    });
    await expect(
      service.editMessage('message', stranger, 'Changed'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.deleteMessage('message', stranger),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.markAsRead('message', stranger),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(messages.save).not.toHaveBeenCalled();
    expect(messages.delete).not.toHaveBeenCalled();
  });

  it('does not send private push messages to an old unauthorized participant', async () => {
    const { service, conversation, notifications } = fixture();
    const message = Object.assign(new Message(), {
      id: 'message',
      senderId: passenger,
      content: 'Private message',
    });
    await service['notifyConversationParticipants'](conversation, message);
    expect(notifications.sendNotification).toHaveBeenCalledWith(
      `token-${driver}`,
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      driver,
    );
    expect(notifications.sendToMultiple).not.toHaveBeenCalled();
    expect(
      JSON.stringify(notifications.sendNotification.mock.calls),
    ).not.toContain(stranger);
  });

  it('preserves membership-based access for general and support conversations', async () => {
    const { service, conversation, bookings } = fixture();
    conversation.bookingId = '';
    conversation.type = ConversationType.GENERAL;
    await expect(
      service.getConversationMessages(conversationId, stranger),
    ).resolves.toEqual([]);
    conversation.type = ConversationType.SUPPORT;
    await expect(
      service.getConversationMessages(conversationId, stranger),
    ).resolves.toEqual([]);
    expect(bookings.findOne).not.toHaveBeenCalled();
  });
});
