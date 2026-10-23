import { ChatRealtime } from './chat-realtime.service';
import { ChatGateway } from './chat.gateway';

describe('Shared HTTP/socket message delivery', () => {
  it('targets unique server-owned user rooms, not client-selected conversation rooms', () => {
    const realtime = new ChatRealtime();
    const emit = jest.fn(), to = jest.fn().mockReturnValue({ emit });
    realtime.bind({ to } as any);
    const message = { id: 'message', conversationId: 'conversation', content: 'Bonjour' } as any;
    expect(realtime.publish(['sender', 'recipient', 'sender', ''], message)).toBe(true);
    expect(to).toHaveBeenCalledWith(['user:sender', 'user:recipient']);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('new_message', message);
  });
  it('does not turn a committed write into an HTTP error when the adapter is unavailable', () => {
    const realtime = new ChatRealtime();
    expect(realtime.publish(['user'], {} as any)).toBe(false);
    realtime.bind({ to: () => { throw new Error('synthetic adapter outage'); } } as any);
    expect(realtime.publish(['user'], {} as any)).toBe(false);
  });
  it('acknowledges legacy socket sends without publishing a second copy', async () => {
    const chat = { createMessage: jest.fn().mockResolvedValue({ id: 'saved' }) };
    const gateway = new ChatGateway(chat as any, {} as any, {} as any, {} as any);
    const to = jest.fn(); gateway.server = { to } as any;
    expect(await gateway.handleSendMessage({ data: { userId: 'sender' } } as any,
      { bookingId: 'booking', content: 'Bonjour' })).toEqual({ success: true, messageId: 'saved' });
    expect(chat.createMessage).toHaveBeenCalledWith('booking', 'sender', 'Bonjour');
    expect(to).not.toHaveBeenCalled();
  });
});
